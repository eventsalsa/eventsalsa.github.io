---
title: Encryption
description: Secure event payloads with envelope encryption, crypto-shredding, key rotation, and clean integration boundaries.
---

`eventsalsa/encryption` is the security-focused part of the bundle. It is meant for the two places where event-sourced systems usually need the most discipline: personal data that should not sit in cleartext forever, and operational secrets that need a sensible rotation story.

Treat encryption as an early design concern. Event stores are append-only by design. Once sensitive fields land in payloads in the wrong form, fixing that later is expensive and often incomplete.

`eventsalsa/encryption` does **not** depend on `eventsalsa/store` or `eventsalsa/worker`. It fits naturally with both, but you can also use it in a different persistence model if that suits your system better.

:::caution
If there is any realistic chance that a field contains PII, credentials, tokens, or other regulated data, decide how it will be protected before the event schema becomes part of your system. With immutable events, this is a one-way door.
:::

## How the two-tier model works

The component uses envelope encryption. Instead of encrypting business data directly with one long-lived root key, it keeps two layers in play:

1. **System keys** (KEKs) protect scope keys.
2. **Scope keys** (DEKs) protect your application data.

At runtime the flow is simple:

- on encrypt, the component loads the active scope key, decrypts it with the system key, and encrypts the plaintext
- on decrypt, it loads the recorded scope-key version, resolves the matching system key, and decrypts the ciphertext

That separation is what makes crypto-shredding and rotation practical. You do not need to rewrite historical events just because key material changed.

| Layer | What it protects | Where it lives |
| --- | --- | --- |
| System key | Scope keys | Your keyring |
| Scope key | Business data | The key store |
| Ciphertext | Sensitive fields | Your events, tables, or messages |

## Understand system keys and scope keys

Two terms matter throughout the chapter:

- a **system key** is a long-lived root key loaded by your application from a trusted source
- a **scope key** is created for one logical `(scope, scopeID)` pair, such as `user-pii:user-123`

Every stored scope key records the `system_key_id` that was used to encrypt it. That is what allows new keys to move forward under a new system key while older records remain decryptable for as long as the older system key is still available.

### Prepare a system key

The file-based keyring reads **base64-encoded 32-byte keys**. In practice that means:

- the decoded key must be exactly 32 bytes long
- the file should contain the base64 text for that key
- a trailing newline is fine
- the file should come from your secret-management flow, not from version control

For local development, one straightforward way to produce such a file is:

```bash
mkdir -p .secrets
openssl rand -base64 32 > .secrets/eventsalsa-system-key-2025-01
```

That file is suitable for `systemkey.NewKeyringFromFiles(...)`. In production, teams usually inject the same kind of material through mounted secrets, a vault, or a similar trusted delivery mechanism.

:::note
Keep system-key files out of git. They are operational secrets, not application assets.
:::

## Installation

Install the dependency once:

```bash
go get github.com/eventsalsa/encryption
```

The PostgreSQL key-store adapter ships with the same dependency, so you can import `github.com/eventsalsa/encryption/keystore/postgres` directly.

## Generate the migration SQL

The quickest path for the database migration is the stable `migrate-gen` command:

```bash
go run github.com/eventsalsa/encryption/cmd/migrate-gen \
  -output ./db/migrations \
  -filename 003_encryption_keys.sql
```

If you want the SQL on stdout instead of in a file:

```bash
go run github.com/eventsalsa/encryption/cmd/migrate-gen -stdout
```

If your project uses a different schema or table name, the same CLI exposes those overrides directly:

```bash
go run github.com/eventsalsa/encryption/cmd/migrate-gen \
  -schema infra \
  -table encryption_keys \
  -stdout
```

The defaults are:

- schema: `infrastructure`
- table: `encryption_keys`

## Setup

Let's set up a keyring, a key store, and a cipher. If you import `cipher/aesgcm`, AES-256-GCM is registered as the default cipher automatically.

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

func main() {
	db, err := sql.Open("postgres", "postgres://postgres:postgres@localhost:5432/eventsalsa?sslmode=disable")
	if err != nil {
		log.Fatal(err)
	}

	keyring, err := systemkey.NewKeyringFromFiles(systemkey.FileKeyConfig{
		KeyPaths: map[string]string{
			"2025-01": ".secrets/eventsalsa-system-key-2025-01",
		},
		ActiveKeyID: "2025-01",
	})
	if err != nil {
		log.Fatal(err)
	}

	keyStore := postgres.NewStore(postgres.DefaultConfig(), db)

	security := encryption.NewWithDefaults(
		keyring,
		keyStore,
		encryption.WithHMACKey([]byte("replace-me-with-32-random-bytes")),
	)

	_ = security
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

## Keep encrypted PII in your own value objects

If you want to preserve a clean domain boundary, do **not** put `pii.EncryptedValue` directly into your domain event types. A better shape is:

1. define your own encrypted value objects
2. let the application service encrypt plaintext before it reaches the aggregate
3. let the aggregate emit events that already carry encrypted data
4. let the repository adapter persist those events with `eventmap-gen` helpers

### Define encrypted values in your own domain

```go
package user

type EncryptedEmail string
type EncryptedFirstName string
type EncryptedLastName string

type UserRegistered struct {
	UserID    string
	Email     EncryptedEmail
	FirstName EncryptedFirstName
	LastName  EncryptedLastName
	EmailHash string
}

type UserDeleted struct {
	UserID string
}

type User struct {
	id          string
	version     int
	uncommitted []any
}

func Register(
	userID string,
	email EncryptedEmail,
	firstName EncryptedFirstName,
	lastName EncryptedLastName,
	emailHash string,
) *User {
	u := &User{id: userID}
	u.uncommitted = append(u.uncommitted, UserRegistered{
		UserID:    userID,
		Email:     email,
		FirstName: firstName,
		LastName:  lastName,
		EmailHash: emailHash,
	})
	return u
}

func (u *User) Delete() {
	u.uncommitted = append(u.uncommitted, UserDeleted{UserID: u.id})
}

func (u *User) Version() int { return u.version }

func (u *User) UncommittedEvents() []any { return u.uncommitted }

func (u *User) ClearUncommittedEvents() { u.uncommitted = nil }
```

### Keep the repository focused on persistence

The repository should load and save aggregates. The repository adapter can replay streams, turn uncommitted domain events into `store.Event` values with generated helpers, and append them. It should not be the place where plaintext is encrypted or where key-destruction policy is decided.

```go
type UserRepository interface {
	// The repository adapter loads aggregates from the store and persists
	// the aggregate's uncommitted encrypted events with eventmap-gen helpers.
	Load(ctx context.Context, userID string) (*user.User, error)
	Save(ctx context.Context, aggregate *user.User) error
}
```

### Encrypt before creating the aggregate event

That work belongs naturally in an application service or CQRS command handler.

```go
package app

import (
	"context"

	encryptionhash "github.com/eventsalsa/encryption/hash"
	"github.com/eventsalsa/encryption/keymanager"
	"github.com/eventsalsa/encryption/pii"

	"github.com/acme/shop/internal/domain/user"
)

type UserID string

func (id UserID) String() string { return string(id) }

type RegistrationService struct {
	users   UserRepository
	keys    *keymanager.Manager
	userPII *pii.Adapter[UserID]
	hasher  encryptionhash.Hasher
}

func (s *RegistrationService) Register(
	ctx context.Context,
	userID string,
	email string,
	firstName string,
	lastName string,
) error {
	if _, err := s.keys.CreateKey(ctx, "user-pii", userID); err != nil {
		return err
	}

	encryptedEmail, err := s.userPII.Encrypt(ctx, UserID(userID), email)
	if err != nil {
		return err
	}
	encryptedFirstName, err := s.userPII.Encrypt(ctx, UserID(userID), firstName)
	if err != nil {
		return err
	}
	encryptedLastName, err := s.userPII.Encrypt(ctx, UserID(userID), lastName)
	if err != nil {
		return err
	}

	aggregate := user.Register(
		userID,
		user.EncryptedEmail(encryptedEmail),
		user.EncryptedFirstName(encryptedFirstName),
		user.EncryptedLastName(encryptedLastName),
		s.hasher.Hash(email),
	)

	return s.users.Save(ctx, aggregate)
}
```

If you want key creation and `Save(...)` to be atomic, run the service inside a unit of work and let the shared `context.Context` carry the transaction so both the encryption key store and the repository adapter see the same `*sql.Tx`.

## Project decrypted data

Encrypted payloads are not meant for querying directly. The usual pattern is to decrypt them inside a projection and write the cleartext only into the read model that genuinely needs it. That read model should still keep enough state to remain idempotent during replay.

For a user directory, the read model should keep the last applied global position so updates can remain idempotent:

```sql
CREATE TABLE read_model.user_directory_v1 (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email_hash TEXT NOT NULL UNIQUE,
    last_global_position BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_user_directory_v1_email_hash
    ON read_model.user_directory_v1 (email_hash);
```

The projection can then upsert only when the incoming event is newer than what the row has already seen.

```go
package projections

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/eventsalsa/encryption/pii"
	"github.com/eventsalsa/store"

	userv1 "github.com/acme/shop/internal/domain/user/events/v1"
	userevents "github.com/acme/shop/internal/infrastructure/persistence/userevents"
)

type UserID string

func (id UserID) String() string { return string(id) }

type UserDirectoryProjection struct {
	userPII *pii.Adapter[UserID]
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
				email_hash,
				last_global_position
			)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (user_id) DO UPDATE
			SET email = EXCLUDED.email,
			    first_name = EXCLUDED.first_name,
			    last_name = EXCLUDED.last_name,
			    email_hash = EXCLUDED.email_hash,
			    last_global_position = EXCLUDED.last_global_position
			WHERE read_model.user_directory_v1.last_global_position < EXCLUDED.last_global_position
		`, e.UserID, email, firstName, lastName, e.EmailHash, event.GlobalPosition)
		return err
	}

	return nil
}
```

That same projection can run inline for strong consistency or through `eventsalsa/worker` when eventual consistency is the better trade-off.

## Delete personal data without rewriting history

When a user is deleted, the write side should still record a business event such as `UserDeleted`. Separately, the user's encryption key should be destroyed so earlier encrypted PII becomes unreadable.

That key destruction should usually happen in the same unit of work as the append. The important point is ownership: the repository adapter persists aggregates, while the application layer decides when the key lifecycle action should happen.

You do not need a large example here. The rule is simple:

- append `UserDeleted`
- call `KeyManager.DestroyKeys(ctx, "user-pii", userID)`
- make both steps part of the same unit of work if you need atomicity

On the read side, the deletion branch simply removes the row:

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

If you want the delete path to retain the same last-position guard after the row is gone, keep a small tombstone or projection-state table keyed by `user_id` and store the delete event's `global_position` there in the same transaction.

:::caution
For PII, destruction is usually the decisive operation. Revocation is not enough if the requirement is that historical personal data must become unreadable.
:::

## Rotate secrets

Secrets have a different lifecycle. API tokens, webhook credentials, and similar values usually need rotation, and older ciphertext may still need to be replayed or audited later.

The business fact is usually that a credential was set or replaced. Scope-key rotation is an infrastructure concern that the application layer handles before the aggregate emits its event.

One way to model the encrypted value in your own domain is:

```go
package integration

type EncryptedAPIKey struct {
	Content    string
	KeyVersion int
}

type APICredentialSet struct {
	IntegrationID string
	Provider      string
	APIKey        EncryptedAPIKey
}
```

A command handler can then rotate the scope key, encrypt the new credential, and pass the encrypted value into the aggregate:

```go
package app

import (
	"context"

	"github.com/eventsalsa/encryption/keymanager"
	"github.com/eventsalsa/encryption/secret"

	"github.com/acme/shop/internal/domain/integration"
)

type IntegrationRepository interface {
	Load(ctx context.Context, integrationID string) (*integration.Aggregate, error)
	Save(ctx context.Context, aggregate *integration.Aggregate) error
}

type ReplaceCredentialHandler struct {
	integrations IntegrationRepository
	keys         *keymanager.Manager
	secrets      *secret.Adapter
}

func (h *ReplaceCredentialHandler) Handle(
	ctx context.Context,
	integrationID string,
	provider string,
	plaintextAPIKey string,
) error {
	scope := "integration-api-token"

	if _, err := h.keys.RotateKey(ctx, scope, integrationID); err != nil {
		return err
	}

	encryptedAPIKey, err := h.secrets.Encrypt(ctx, scope, integrationID, plaintextAPIKey)
	if err != nil {
		return err
	}

	aggregate, err := h.integrations.Load(ctx, integrationID)
	if err != nil {
		return err
	}

	aggregate.SetCredential(
		provider,
		integration.EncryptedAPIKey{
			Content:    encryptedAPIKey.Content,
			KeyVersion: encryptedAPIKey.KeyVersion,
		},
	)

	return h.integrations.Save(ctx, aggregate)
}
```

The important part is the split of responsibilities:

- the application layer rotates the key and encrypts the new secret
- the aggregate records the business fact that the credential changed
- the repository adapter only persists the resulting events

## Rotate system keys

System-key rotation is separate from scope-key rotation. Making a new system key active only affects new `CreateKey(...)` and `RotateKey(...)` calls. Existing stored scope keys keep the `system_key_id` they were written with, so retiring the old key also requires a rewrap step.

Start by loading both the old and new system keys into the keyring, then make the new key active for fresh writes:

```go
keyring, err := systemkey.NewKeyringFromFiles(systemkey.FileKeyConfig{
	KeyPaths: map[string]string{
		"2025-01": ".secrets/eventsalsa-system-key-2025-01",
		"2025-04": ".secrets/eventsalsa-system-key-2025-04",
	},
	ActiveKeyID: "2025-04",
})
```

With both keys available, use the PostgreSQL administrative API to re-encrypt stored DEKs from the old system key to the new one. A dry run tells you how many rows still depend on the old key without changing anything:

```go
rewrapCipher := aesgcm.New()

preview, err := keyStore.RewrapSystemKeys(ctx, keyring, rewrapCipher, postgres.RewrapSystemKeysOptions{
	FromSystemKeyID: "2025-01",
	ToSystemKeyID:   "2025-04",
	BatchSize:       500,
	DryRun:          true,
})
if err != nil {
	return err
}

log.Printf("matched=%d remaining=%d", preview.MatchedRows, preview.RemainingRows)
```

Then run the actual rewrap until `RemainingRows` reaches zero:

```go
result, err := keyStore.RewrapSystemKeys(ctx, keyring, rewrapCipher, postgres.RewrapSystemKeysOptions{
	FromSystemKeyID: "2025-01",
	ToSystemKeyID:   "2025-04",
	BatchSize:       500,
})
if err != nil {
	return err
}

log.Printf(
	"rewrapped=%d skipped=%d remaining=%d batches=%d",
	result.RewrappedRows,
	result.SkippedRows,
	result.RemainingRows,
	result.Batches,
)
```

This operation updates the stored encrypted DEK and `system_key_id` in place. It preserves the existing `(scope, scope_id, key_version)` identity, covers revoked rows as well as active rows, and does **not** rotate DEKs or re-encrypt application ciphertext.

Operationally, the sequence is:

1. load both system keys into the keyring
2. make the new system key active for new writes
3. run `RewrapSystemKeys` from the old key ID to the new key ID until `RemainingRows` is zero
4. verify the result, then retire the old system key

Keep the old key available until the rewrap is complete and you have confirmed that the remaining row count is zero. System-key rotation is an administrative operation around key storage, not a domain event and not a replacement for secret-level key rotation.

## Use hashing for sensitive identifiers and lookups

Some values should be searchable or usable as stable identifiers without being readable. That is where the component's HMAC hasher fits.

One practical use case is deriving an aggregate ID from sensitive data such as a normalized email address or, in some systems, a username:

```go
aggregateID := security.Hasher.Hash(normalizedEmail)
```

That is also useful on the read side for cases such as:

- uniqueness checks on an email address
- locating a record by a sensitive identifier
- joining to a read model without using the cleartext value as the index key

Keep the HMAC key separate from your system keys. It solves a different problem.

## Bring your own cipher or key store

The package stays deliberately small at the edges. If you need a different cipher or a different persistence backend, you can swap those pieces out without changing the higher-level lifecycle.

For a custom cipher, implement `cipher.Cipher` and pass it through `encryption.Config` or `encryption.WithCipher(...)`. For a custom key store, implement `keystore.KeyStore` and keep the same `(scope, scopeID, version)` semantics.

That makes `eventsalsa/encryption` a practical default rather than a hard dependency on one storage model. The important part is the discipline around key lifecycle and transaction boundaries, not whether the DEKs happen to live in PostgreSQL.
