---
title: Encryption
description: Secure event payloads with envelope encryption, crypto-shredding, key rotation, and clean integration boundaries.
---

`eventsalsa/encryption` is the security-focused part of the bundle. It is designed for the places where event-sourced systems usually get uncomfortable: personal data that should not sit in cleartext forever, and secrets that need a deliberate rotation story.

Treat encryption as an early design concern. Event stores are append-only by design. If sensitive fields land in payloads in the wrong form, fixing that later is expensive, awkward, and often incomplete.

`eventsalsa/encryption` does **not** depend on `eventsalsa/store` or `eventsalsa/worker`. It fits naturally with both, but you can also use it in a different persistence setup if that better matches your application.

:::caution
If there is any realistic chance that a field contains PII, credentials, tokens, or other regulated data, decide how it will be protected before the event schema becomes part of your system. With immutable events, this is a one-way door.
:::

## How the two-tier model works

The component uses envelope encryption. Instead of encrypting business data directly with one long-lived root key, it keeps two layers in play:

1. **System keys** (KEKs) protect scope keys.
2. **Scope keys** (DEKs) protect your application data.

At runtime the flow is simple:

- on encrypt, the module loads the active scope key, decrypts it with the system key, and encrypts the plaintext
- on decrypt, it loads the recorded scope-key version, resolves the matching system key, and decrypts the ciphertext

That separation is what makes crypto-shredding and rotation practical. You do not have to rewrite historical events just because key material changed.

| Layer | What it protects | Where it lives |
| --- | --- | --- |
| System key | Scope keys | Your keyring |
| Scope key | Business data | The key store |
| Ciphertext | Sensitive fields | Your events, tables, or messages |

## Understand system keys and scope keys

It helps to be explicit about the terminology:

- a **system key** is a long-lived root key loaded by your application from a trusted source
- a **scope key** is created for one logical `(scope, scopeID)` pair, such as `user-pii:user-123`

Every stored scope key records the `system_key_id` that was used to encrypt it. That is important later: when the active system key changes, new scope keys use the new system key, while older scope keys still point to the earlier one and remain decryptable as long as that older system key is still available.

### Prepare a system key

The file-based keyring reads **base64-encoded 32-byte keys**. In practice that means:

- the underlying decoded key must be exactly 32 bytes long
- the file should contain the base64 text for that key
- a trailing newline is fine
- the file should come from your secret-management flow, not from version control

For local development, one straightforward way to generate such a file is:

```bash
mkdir -p .secrets
openssl rand -base64 32 > .secrets/eventsalsa-system-key-2025-01
```

That command writes one key file suitable for `systemkey.NewKeyringFromFiles(...)`. In production, teams usually inject the same kind of material through mounted secrets, a vault, or another trusted secret-distribution mechanism.

:::note
Keep system-key files out of git. They are operational secrets, not application assets.
:::

## Install and create the key table

You only need one module download:

```bash
go get github.com/eventsalsa/encryption
```

The PostgreSQL key-store adapter lives inside that same module, so once the module is available you can import `github.com/eventsalsa/encryption/keystore/postgres` directly.

The PostgreSQL adapter uses a small key table. At the moment the package ships the SQL migration as embedded source rather than a dedicated `migrate-gen` command, so the usual approach is to copy this into your migration tool or load the embedded SQL from your own setup code.

```sql
CREATE TABLE IF NOT EXISTS infrastructure.encryption_keys (
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    key_version INT NOT NULL,
    encrypted_key BYTEA NOT NULL,
    system_key_id TEXT NOT NULL DEFAULT 'default',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (scope, scope_id, key_version),
    CONSTRAINT scope_not_empty CHECK (scope <> ''),
    CONSTRAINT scope_id_not_empty CHECK (scope_id <> ''),
    CONSTRAINT key_version_positive CHECK (key_version > 0),
    CONSTRAINT encrypted_key_not_empty CHECK (length(encrypted_key) > 0),
    CONSTRAINT system_key_id_not_empty CHECK (system_key_id <> '')
);

CREATE INDEX IF NOT EXISTS idx_encryption_keys_active
    ON infrastructure.encryption_keys(scope, scope_id, revoked_at)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_encryption_keys_system_key_id
    ON infrastructure.encryption_keys(system_key_id);
```

The defaults are:

- schema: `infrastructure`
- table: `encryption_keys`

You can override both with `postgres.Config`.

## Wire the module

The module needs a keyring, a key store, and a cipher. If you import `cipher/aesgcm`, AES-256-GCM is registered as the default cipher automatically.

```go
package main

import (
	"database/sql"
	"log"

	"github.com/eventsalsa/encryption"
	_ "github.com/eventsalsa/encryption/cipher/aesgcm"
	"github.com/eventsalsa/encryption/keystore/postgres"
	"github.com/eventsalsa/encryption/systemkey"
)

func openEncryptionModule(db *sql.DB) *encryption.Module {
	keyring, err := systemkey.NewKeyringFromFiles(systemkey.FileKeyConfig{
		KeyPaths: map[string]string{
			"2025-01": ".secrets/eventsalsa-system-key-2025-01",
		},
		ActiveKeyID: "2025-01",
	})
	if err != nil {
		log.Fatal(err)
	}

	keyStore := postgres.NewStore(postgres.Config{
		Schema: "infrastructure",
		Table:  "encryption_keys",
	}, db)

	return encryption.NewWithDefaults(
		keyring,
		keyStore,
		encryption.WithHMACKey([]byte("replace-me-with-32-random-bytes")),
	)
}
```

By default the PostgreSQL key store uses `*sql.DB`. That is fine for simple setups. In an event-sourced application, though, you usually want key creation, encryption-related writes, and event appends to live inside the same transaction.

### Use an existing `*sql.Tx`

The PostgreSQL key store checks the context for a transaction first. If you attach one with `keystore.WithTx`, all reads and writes go through that transaction instead of the pool.

```go
tx, err := db.BeginTx(ctx, nil)
if err != nil {
	return err
}
defer tx.Rollback()

ctx = keystore.WithTx(ctx, tx)
```

If your application carries transactions through a different context key, `postgres.NewStoreWithTxExtractor(...)` lets you plug that into the same flow.

:::note
That transaction-aware behavior is one of the most useful integration points in the component. The package stays storage-agnostic at the interface level, while the PostgreSQL adapter still plays well with an existing unit of work.
:::

## Encrypt PII without pushing infrastructure into the domain

The cleanest pattern is to keep the domain model free of `eventsalsa/encryption` types, and let the repository translate plain domain events into encrypted persistence events inside the transaction.

### Keep the aggregate and domain events plain

In the domain layer, the aggregate collects ordinary business events. Nothing here needs to know about `pii.EncryptedValue`.

```go
package user

type Registered struct {
	UserID    string
	Email     string
	FirstName string
	LastName  string
}

type Deleted struct {
	UserID string
}

type User struct {
	id          string
	version     int
	uncommitted []any
}

func Register(userID, email, firstName, lastName string) *User {
	u := &User{id: userID}
	u.uncommitted = append(u.uncommitted, Registered{
		UserID:    userID,
		Email:     email,
		FirstName: firstName,
		LastName:  lastName,
	})
	return u
}

func (u *User) Delete() {
	u.uncommitted = append(u.uncommitted, Deleted{UserID: u.id})
}

func (u *User) ID() string {
	return u.id
}

func (u *User) Version() int {
	return u.version
}

func (u *User) UncommittedEvents() []any {
	return u.uncommitted
}

func (u *User) ClearUncommittedEvents() {
	u.uncommitted = nil
}
```

### Define persistence events with your own encrypted types

On the persistence side, you can still keep the boundary clean by defining your own encrypted field types instead of putting `pii.EncryptedValue` directly into the event schema package.

```go
package v1

type EncryptedEmail string
type EncryptedFirstName string
type EncryptedLastName string

type UserRegistered struct {
	UserID    string             `json:"user_id"`
	Email     EncryptedEmail     `json:"email"`
	FirstName EncryptedFirstName `json:"first_name"`
	LastName  EncryptedLastName  `json:"last_name"`
	EmailHash string             `json:"email_hash"`
}

type UserDeleted struct {
	UserID string `json:"user_id"`
}
```

That way the event payload is still explicit about being encrypted, but the domain model does not take a dependency on the infrastructure package.

### Let the repository translate and persist

A repository in an event-sourced system should do repository work: load aggregates and save aggregates. A separate application service can decide *when* registration or deletion happens.

```go
package persistence

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/eventsalsa/encryption"
	"github.com/eventsalsa/encryption/keystore"
	"github.com/eventsalsa/encryption/pii"
	"github.com/eventsalsa/store"

	"github.com/acme/shop/internal/domain/user"
	userv1 "github.com/acme/shop/internal/infrastructure/persistence/userevents/v1"
	userevents "github.com/acme/shop/internal/infrastructure/persistence/userevents"
)

type UserID string

func (id UserID) String() string { return string(id) }

type UserRepository interface {
	Load(ctx context.Context, userID string) (*user.User, error)
	Save(ctx context.Context, aggregate *user.User) error
}

type PostgresUserRepository struct {
	db       *sql.DB
	store    store.Store
	security *encryption.Module
	userPII  *pii.Adapter[UserID]
}

func (r *PostgresUserRepository) Save(ctx context.Context, aggregate *user.User) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ctx = keystore.WithTx(ctx, tx)

	var esEvents []store.Event
	destroyUserKey := false

	for _, pending := range aggregate.UncommittedEvents() {
		switch e := pending.(type) {
		case user.Registered:
			if _, err := r.security.KeyManager.CreateKey(ctx, "user-pii", e.UserID); err != nil {
				return fmt.Errorf("create user key: %w", err)
			}

			encryptedEmail, err := r.userPII.Encrypt(ctx, UserID(e.UserID), e.Email)
			if err != nil {
				return fmt.Errorf("encrypt email: %w", err)
			}
			encryptedFirstName, err := r.userPII.Encrypt(ctx, UserID(e.UserID), e.FirstName)
			if err != nil {
				return fmt.Errorf("encrypt first name: %w", err)
			}
			encryptedLastName, err := r.userPII.Encrypt(ctx, UserID(e.UserID), e.LastName)
			if err != nil {
				return fmt.Errorf("encrypt last name: %w", err)
			}

			esEvent, err := userevents.ToUserRegisteredV1(
				"User",
				e.UserID,
				userv1.UserRegistered{
					UserID:    e.UserID,
					Email:     userv1.EncryptedEmail(encryptedEmail),
					FirstName: userv1.EncryptedFirstName(encryptedFirstName),
					LastName:  userv1.EncryptedLastName(encryptedLastName),
					EmailHash: r.security.Hasher.Hash(e.Email),
				},
			)
			if err != nil {
				return fmt.Errorf("build user registered event: %w", err)
			}

			esEvents = append(esEvents, esEvent)

		case user.Deleted:
			esEvent, err := userevents.ToUserDeletedV1(
				"User",
				e.UserID,
				userv1.UserDeleted{UserID: e.UserID},
			)
			if err != nil {
				return fmt.Errorf("build user deleted event: %w", err)
			}

			esEvents = append(esEvents, esEvent)
			destroyUserKey = true
		}
	}

	if _, err := r.store.Append(ctx, tx, store.AppendInput{
		ExpectedVersion: store.Exact(aggregate.Version()),
		Events:          esEvents,
	}); err != nil {
		return fmt.Errorf("append user stream: %w", err)
	}

	if destroyUserKey {
		if err := r.security.KeyManager.DestroyKeys(ctx, "user-pii", aggregate.ID()); err != nil {
			return fmt.Errorf("destroy user key: %w", err)
		}
	}

	aggregate.ClearUncommittedEvents()
	return tx.Commit()
}
```

The application service stays small and focused:

```go
type RegistrationService struct {
	users UserRepository
}

func (s *RegistrationService) Register(
	ctx context.Context,
	userID string,
	email string,
	firstName string,
	lastName string,
) error {
	aggregate := user.Register(userID, email, firstName, lastName)
	return s.users.Save(ctx, aggregate)
}
```

:::caution
Create the key, encrypt the fields, build the persistence events, and append them in the same database transaction. If those steps drift apart, you can end up with ciphertext that no durable event references, or with events that can never be decrypted reliably later.
:::

## Project decrypted data into an idempotent read model

Encrypted payloads are not meant for querying directly. The usual pattern is to decrypt them inside a projection and write the cleartext only into the read model that genuinely needs it.

For a user directory, the read model might look like this:

```sql
CREATE TABLE read_model.user_directory_v1 (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email_hash TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_user_directory_v1_email_hash
    ON read_model.user_directory_v1 (email_hash);
```

This projection is idempotent by construction:

- `UserRegistered` uses an upsert
- `UserDeleted` uses a delete, which is naturally repeatable

```go
package projections

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/eventsalsa/encryption/pii"
	"github.com/eventsalsa/store"

	userv1 "github.com/acme/shop/internal/infrastructure/persistence/userevents/v1"
	userevents "github.com/acme/shop/internal/infrastructure/persistence/userevents"
)

type UserID string

func (id UserID) String() string { return string(id) }

type UserDirectoryProjection struct {
	userPII *pii.Adapter[UserID]
}

func (p *UserDirectoryProjection) Name() string {
	return "user_directory_projection"
}

func (p *UserDirectoryProjection) Handle(ctx context.Context, tx *sql.Tx, event store.PersistedEvent) error {
	domainEvent, err := userevents.FromESEvent(event)
	if err != nil {
		return fmt.Errorf("decode event: %w", err)
	}

	switch e := domainEvent.(type) {
	case userv1.UserRegistered:
		userID := UserID(e.UserID)

		email, err := p.userPII.Decrypt(ctx, userID, pii.EncryptedValue(e.Email))
		if err != nil {
			return fmt.Errorf("decrypt email: %w", err)
		}
		firstName, err := p.userPII.Decrypt(ctx, userID, pii.EncryptedValue(e.FirstName))
		if err != nil {
			return fmt.Errorf("decrypt first name: %w", err)
		}
		lastName, err := p.userPII.Decrypt(ctx, userID, pii.EncryptedValue(e.LastName))
		if err != nil {
			return fmt.Errorf("decrypt last name: %w", err)
		}

		_, err = tx.ExecContext(ctx, `
			INSERT INTO read_model.user_directory_v1 (
				user_id,
				email,
				first_name,
				last_name,
				email_hash
			)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (user_id) DO UPDATE
			SET email = EXCLUDED.email,
			    first_name = EXCLUDED.first_name,
			    last_name = EXCLUDED.last_name,
			    email_hash = EXCLUDED.email_hash
		`, e.UserID, email, firstName, lastName, e.EmailHash)
		return err

	case userv1.UserDeleted:
		_, err := tx.ExecContext(ctx, `
			DELETE FROM read_model.user_directory_v1
			WHERE user_id = $1
		`, e.UserID)
		return err
	}

	return nil
}
```

That same projection can run inline for strong consistency or through `eventsalsa/worker` when eventual consistency is the better trade-off.

## Delete personal data without rewriting history

A deletion workflow in an event-sourced system usually has two coordinated outcomes:

1. the write side records a business event such as `UserDeleted`
2. the encryption layer destroys the user's scope key in the same transaction

That keeps the business story intact while making earlier encrypted PII unreadable.

On the read side, the deletion branch is intentionally boring. The projection sees `UserDeleted` and removes the row:

```go
func (p *UserDirectoryProjection) Handle(ctx context.Context, tx *sql.Tx, event store.PersistedEvent) error {
	domainEvent, err := userevents.FromESEvent(event)
	if err != nil {
		return fmt.Errorf("decode event: %w", err)
	}

	switch e := domainEvent.(type) {
	case userv1.UserDeleted:
		_, err := tx.ExecContext(ctx, `
			DELETE FROM read_model.user_directory_v1
			WHERE user_id = $1
		`, e.UserID)
		return err

	default:
		// The rest of the user events are handled elsewhere in the same projection.
		return nil
	}
}
```

:::caution
For PII, destruction is usually the decisive operation. Revocation is not enough if the requirement is that historical personal data must become unreadable.
:::

## Rotate secrets without breaking old events

Secrets have a different lifecycle. API tokens, webhook credentials, and similar values usually need rotation, and older ciphertext may still need to be replayed or audited later.

The same boundary rule applies here as well:

- plain domain events in the domain layer
- encrypted persistence events in the infrastructure layer
- the repository performs the translation while saving

One persistence-event shape might look like this:

```go
package v1

type EncryptedAPIKey struct {
	Content    string `json:"content"`
	KeyVersion int    `json:"key_version"`
}

type APICredentialSet struct {
	IntegrationID string          `json:"integration_id"`
	Provider      string          `json:"provider"`
	APIKey        EncryptedAPIKey `json:"api_key"`
}
```

When the aggregate has a first credential to persist, the repository creates a scope key. When the credential is replaced, the repository rotates that key before encrypting the new value.

```go
func (r *PostgresIntegrationRepository) Save(ctx context.Context, aggregate *integration.Integration) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ctx = keystore.WithTx(ctx, tx)

	var esEvents []store.Event
	scope := "integration-api-token"

	for _, pending := range aggregate.UncommittedEvents() {
		switch e := pending.(type) {
		case integration.APICredentialAdded:
			if _, err := r.security.KeyManager.CreateKey(ctx, scope, e.IntegrationID); err != nil {
				return fmt.Errorf("create integration key: %w", err)
			}

			encryptedAPIKey, err := r.secretAdapter.Encrypt(ctx, scope, e.IntegrationID, e.APIKey)
			if err != nil {
				return fmt.Errorf("encrypt api key: %w", err)
			}

			esEvent, err := integrationevents.ToAPICredentialSetV1(
				"Integration",
				e.IntegrationID,
				integrationv1.APICredentialSet{
					IntegrationID: e.IntegrationID,
					Provider:      e.Provider,
					APIKey: integrationv1.EncryptedAPIKey{
						Content:    encryptedAPIKey.Content,
						KeyVersion: encryptedAPIKey.KeyVersion,
					},
				},
			)
			if err != nil {
				return fmt.Errorf("build credential event: %w", err)
			}

			esEvents = append(esEvents, esEvent)

		case integration.APICredentialRotated:
			if _, err := r.security.KeyManager.RotateKey(ctx, scope, e.IntegrationID); err != nil {
				return fmt.Errorf("rotate integration key: %w", err)
			}

			encryptedAPIKey, err := r.secretAdapter.Encrypt(ctx, scope, e.IntegrationID, e.APIKey)
			if err != nil {
				return fmt.Errorf("encrypt rotated api key: %w", err)
			}

			esEvent, err := integrationevents.ToAPICredentialSetV1(
				"Integration",
				e.IntegrationID,
				integrationv1.APICredentialSet{
					IntegrationID: e.IntegrationID,
					Provider:      e.Provider,
					APIKey: integrationv1.EncryptedAPIKey{
						Content:    encryptedAPIKey.Content,
						KeyVersion: encryptedAPIKey.KeyVersion,
					},
				},
			)
			if err != nil {
				return fmt.Errorf("build rotated credential event: %w", err)
			}

			esEvents = append(esEvents, esEvent)
		}
	}

	if _, err := r.store.Append(ctx, tx, store.AppendInput{
		ExpectedVersion: store.Exact(aggregate.Version()),
		Events:          esEvents,
	}); err != nil {
		return fmt.Errorf("append integration stream: %w", err)
	}

	aggregate.ClearUncommittedEvents()
	return tx.Commit()
}
```

`RotateKey(...)` creates a new scope-key version and revokes older versions as active write targets. Historical ciphertext still decrypts, because the stored payload remembers the version it was encrypted with.

For credentials, a common policy is:

- rotate when the secret changes
- keep older versions decryptable while history still matters
- destroy the keys later when the integration is removed and the old values no longer need to be recoverable

## Rotate system keys deliberately

System-key rotation is separate from scope-key rotation.

When you mark a different key as active in the keyring, new `CreateKey(...)` and `RotateKey(...)` calls use that system key ID. Existing scope keys keep the `system_key_id` they already have, which means older data remains decryptable only while those older system keys are still available.

```go
keyring, err := systemkey.NewKeyringFromFiles(systemkey.FileKeyConfig{
	KeyPaths: map[string]string{
		"2025-01": ".secrets/eventsalsa-system-key-2025-01",
		"2025-04": ".secrets/eventsalsa-system-key-2025-04",
	},
	ActiveKeyID: "2025-04",
})
```

In practice:

- changing `ActiveKeyID` affects new scope-key creation and rotation
- it does **not** re-encrypt scope keys that already exist
- you should not retire an older system key until every scope key that depends on it has either been replaced or intentionally destroyed

For PII, that last point matters even more because the scoped PII keys do not rotate. The package gives you clean system-key selection, but it does not currently expose a built-in DEK rewrap API.

## Use hashing for sensitive lookups

Some values should be searchable without being readable. That is where the module's HMAC hasher fits.

```go
emailHash := security.Hasher.Hash(email)
```

A keyed hash is useful for cases such as:

- uniqueness checks on an email address
- locating a user by a sensitive identifier
- joining to a read model without using the cleartext value as the index key

Keep the HMAC key separate from your system keys. It solves a different problem.

## Bring your own cipher or key store

The package stays deliberately small at the edges. If you need a different cipher or a different persistence backend, you can swap those pieces out without changing the higher-level lifecycle.

For a custom cipher, implement `cipher.Cipher` and pass it through `encryption.Config` or `encryption.WithCipher(...)`. For a custom key store, implement `keystore.KeyStore` and keep the same `(scope, scopeID, version)` semantics.

That makes `eventsalsa/encryption` a practical default rather than a hard dependency on one storage model. The important part is the discipline around key lifecycle and transaction boundaries, not whether the DEKs happen to live in PostgreSQL.
