---
title: Encryption
description: Secure event payloads with envelope encryption, crypto-shredding, key rotation, and typed integration patterns.
---

`eventsalsa/encryption` is the security-focused part of the bundle. It helps you encrypt event payloads without turning the rest of your application into cryptography plumbing, and it gives you a workable answer for two different problems that show up early in event-sourced systems: personally identifiable information that may need to become unreadable later, and operational secrets that need regular rotation.

Treat encryption as an early design concern, not a cleanup task. Event stores are deliberately append-only. Once sensitive data is written into event payloads in the wrong form, there is rarely a pleasant way back.

`eventsalsa/encryption` does **not** depend on `eventsalsa/store` or `eventsalsa/worker`. You can use it with those components, but you can also wire it into a different persistence model if that fits your system better.

:::caution
If there is any realistic chance that a field contains PII, credentials, tokens, or other regulated data, decide how you will protect it before the first event schema becomes public in your codebase. With immutable events, this is a one-way door.
:::

## How the two-tier model works

The component uses envelope encryption. Instead of encrypting application data directly with a long-lived root key, it uses two layers:

1. **System keys** (KEKs) live in your keyring and protect other keys.
2. **Scope keys** (DEKs) are created per `(scope, scopeID)` pair and encrypt application data.

At runtime the flow is straightforward:

- for encryption, the module loads the active scope key, decrypts that key with the active system key, and then encrypts the plaintext
- for decryption, it loads the recorded key version, resolves the matching system key, and decrypts the ciphertext

That split is what makes both crypto-shredding and rotation workable. You do not need to rewrite historical event payloads to change the key material around them.

| Layer | What it protects | Where it lives |
| --- | --- | --- |
| System key | Scope keys | Your application keyring |
| Scope key | Event payload fields | The encryption key store |
| Ciphertext | Business data | Your events, tables, or messages |

## Install and create the key table

Start by adding the module and the PostgreSQL key-store adapter.

```bash
go get github.com/eventsalsa/encryption
go get github.com/eventsalsa/encryption/keystore/postgres
```

The PostgreSQL adapter uses a small key table. At the moment the package ships the SQL migration as embedded source rather than a dedicated `migrate-gen` command, so the usual approach is to copy this into your migration tool or execute the embedded SQL from your own setup code.

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

You can override both with `postgres.Config` if your project keeps operational tables somewhere else.

## Wire the module

The module needs three things: a keyring, a key store, and a cipher. If you import `cipher/aesgcm`, AES-256-GCM is registered as the default cipher automatically.

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
			"2025-01": "/run/secrets/eventsalsa-system-key-2025-01",
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

The module can work directly with `*sql.DB`, which is convenient for simple setups. In event-sourced code you will usually want something stricter: key creation, encryption-related writes, and event appends should participate in the same transaction.

### Use an existing `*sql.Tx`

The PostgreSQL key store checks the context for a transaction first. If you attach one with `keystore.WithTx`, all reads and writes go through that transaction instead of the connection pool.

```go
tx, err := db.BeginTx(ctx, nil)
if err != nil {
	return err
}
defer tx.Rollback()

ctx = keystore.WithTx(ctx, tx)

// Key-store operations now use tx.
```

If your application already carries transactions through a different context key, `postgres.NewStoreWithTxExtractor(...)` lets you plug that in rather than reshaping the rest of your infrastructure.

:::note
That transaction-aware behavior is one of the most important differences between `eventsalsa/encryption` and the store or worker components. The encryption package is storage-agnostic at the interface level, but the PostgreSQL adapter is careful about joining an existing transaction when one is available.
:::

## Understand system keys and scope keys

System keys and scope keys solve different problems, and it helps to name them deliberately in your project.

- A **system key** is a root key held by your application, usually loaded from files, a secret manager, or a similar trusted source.
- A **scope key** is generated for one logical scope in your data model, such as `user-pii:user-123` or `integration-api-token:integration-42`.

Each stored scope key records the `system_key_id` that was used to encrypt it. That detail matters later during rotation: new keys can move to a new system key, while older records remain decryptable as long as the older system key is still present in the keyring.

## Encrypt PII in event payloads

PII is the clearer of the two security stories. A user's email address, first name, last name, or similar personal fields often need to stay hidden in the event store while still remaining usable inside projections and application workflows.

The PII adapter is built for that case. It does **not** rotate scoped keys. The key version is always `1`, and the usual lifecycle is:

1. create the scope key when the subject appears
2. encrypt new payloads with that key
3. destroy the key later if the data must become unreadable

### Define the event payload

Assume you already use `eventmap-gen` for your store events. A user registration event can carry encrypted values directly.

```go
package v1

import "github.com/eventsalsa/encryption/pii"

type UserRegistered struct {
	UserID    string             `json:"user_id"`
	Email     pii.EncryptedValue `json:"email"`
	FirstName pii.EncryptedValue `json:"first_name"`
	LastName  pii.EncryptedValue `json:"last_name"`
	EmailHash string             `json:"email_hash"`
}
```

The `EmailHash` field is optional, but it is often useful. Encryption is for confidentiality; hashing is for deterministic lookup. If your read side needs to enforce uniqueness or search for a value like an email address without storing it in plaintext, a keyed HMAC is usually the better fit than trying to query ciphertext directly.

### Append the first event in the same transaction that creates the key

The repository adapter is the right place to bridge encryption, event generation, and persistence. This keeps the domain model free of transport concerns while ensuring the append stays atomic.

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

	userv1 "github.com/acme/shop/internal/domain/user/events/v1"
	userevents "github.com/acme/shop/internal/infrastructure/persistence/userevents"
)

type UserID string

func (id UserID) String() string { return string(id) }

type UserRepository struct {
	db       *sql.DB
	store    store.Store
	security *encryption.Module
	userPII  *pii.Adapter[UserID]
}

func (r *UserRepository) Register(
	ctx context.Context,
	userID UserID,
	email string,
	firstName string,
	lastName string,
) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ctx = keystore.WithTx(ctx, tx)

	if _, err := r.security.KeyManager.CreateKey(ctx, "user-pii", userID.String()); err != nil {
		return fmt.Errorf("create user key: %w", err)
	}

	encryptedEmail, err := r.userPII.Encrypt(ctx, userID, email)
	if err != nil {
		return fmt.Errorf("encrypt email: %w", err)
	}
	encryptedFirstName, err := r.userPII.Encrypt(ctx, userID, firstName)
	if err != nil {
		return fmt.Errorf("encrypt first name: %w", err)
	}
	encryptedLastName, err := r.userPII.Encrypt(ctx, userID, lastName)
	if err != nil {
		return fmt.Errorf("encrypt last name: %w", err)
	}

	event, err := userevents.ToUserRegisteredV1("User", userID.String(), userv1.UserRegistered{
		UserID:    userID.String(),
		Email:     encryptedEmail,
		FirstName: encryptedFirstName,
		LastName:  encryptedLastName,
		EmailHash: r.security.Hasher.Hash(email),
	})
	if err != nil {
		return fmt.Errorf("build event: %w", err)
	}

	if _, err := r.store.Append(ctx, tx, store.AppendInput{
		ExpectedVersion: store.NoStream(),
		Events:          []store.Event{event},
	}); err != nil {
		return fmt.Errorf("append user stream: %w", err)
	}

	return tx.Commit()
}
```

:::caution
Create the key, encrypt the payload, and append the event in the same database transaction. If those steps are split, you can end up with an event whose ciphertext cannot be decrypted later, or with an orphaned key that does not correspond to any durable event.
:::

## Project decrypted data into a read model

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

The projection can then decode the persisted event with generated helpers, decrypt the fields, and upsert the query table.

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

		email, err := p.userPII.Decrypt(ctx, userID, e.Email)
		if err != nil {
			return fmt.Errorf("decrypt email: %w", err)
		}
		firstName, err := p.userPII.Decrypt(ctx, userID, e.FirstName)
		if err != nil {
			return fmt.Errorf("decrypt first name: %w", err)
		}
		lastName, err := p.userPII.Decrypt(ctx, userID, e.LastName)
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

That pattern works inline or asynchronously. If the read model must stay strongly consistent with the write, handle the projection in the same transaction as the append. If it can lag behind, move it to `eventsalsa/worker`.

## Delete personal data without rewriting history

A deletion workflow in an event-sourced system usually has two pieces:

1. append a domain event such as `UserDeleted`
2. destroy the user's scope key in the same transaction

The event explains what happened in business terms. The key destruction ensures that earlier encrypted payloads can no longer be turned back into readable personal data.

```go
func (r *UserRepository) Delete(ctx context.Context, userID UserID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ctx = keystore.WithTx(ctx, tx)

	event, err := userevents.ToUserDeletedV1("User", userID.String(), userv1.UserDeleted{
		UserID: userID.String(),
	})
	if err != nil {
		return fmt.Errorf("build event: %w", err)
	}

	if _, err := r.store.Append(ctx, tx, store.AppendInput{
		ExpectedVersion: store.Any(),
		Events:          []store.Event{event},
	}); err != nil {
		return fmt.Errorf("append delete event: %w", err)
	}

	if err := r.security.KeyManager.DestroyKeys(ctx, "user-pii", userID.String()); err != nil {
		return fmt.Errorf("destroy user key: %w", err)
	}

	return tx.Commit()
}
```

The projection side becomes simple: when it sees `UserDeleted`, it removes the row from the read model. It does not need to decrypt anything during the deletion step.

:::caution
For PII, destruction is usually the important operation. Revocation is not enough if the requirement is that historical personal data must become unreadable.
:::

## Rotate secrets without breaking old events

Secrets are a different category. API tokens, webhook credentials, and similar values usually need rotation, and historical ciphertext still needs to remain decryptable for replay, audit, or controlled recovery scenarios.

That is what the `secret` adapter is for. Its encrypted value includes the key version that was used at write time.

```go
package v1

import "github.com/eventsalsa/encryption/secret"

type APICredentialSet struct {
	IntegrationID string                `json:"integration_id"`
	Provider      string                `json:"provider"`
	APIKey        secret.EncryptedValue `json:"api_key"`
}
```

A simple write flow looks like this:

```go
func (r *IntegrationRepository) SaveCredential(
	ctx context.Context,
	integrationID string,
	provider string,
	apiKey string,
	isFirstCredential bool,
) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ctx = keystore.WithTx(ctx, tx)

	scope := "integration-api-token"
	if isFirstCredential {
		if _, err := r.security.KeyManager.CreateKey(ctx, scope, integrationID); err != nil {
			return fmt.Errorf("create integration key: %w", err)
		}
	} else {
		if _, err := r.security.KeyManager.RotateKey(ctx, scope, integrationID); err != nil {
			return fmt.Errorf("rotate integration key: %w", err)
		}
	}

	encryptedAPIKey, err := r.secretAdapter.Encrypt(ctx, scope, integrationID, apiKey)
	if err != nil {
		return fmt.Errorf("encrypt api key: %w", err)
	}

	event, err := integrationevents.ToAPICredentialSetV1(
		"Integration",
		integrationID,
		integrationv1.APICredentialSet{
			IntegrationID: integrationID,
			Provider:      provider,
			APIKey:        encryptedAPIKey,
		},
	)
	if err != nil {
		return fmt.Errorf("build event: %w", err)
	}

	if _, err := r.store.Append(ctx, tx, store.AppendInput{
		ExpectedVersion: store.Any(),
		Events:          []store.Event{event},
	}); err != nil {
		return fmt.Errorf("append credential event: %w", err)
	}

	return tx.Commit()
}
```

`RotateKey(...)` creates a new scope key version and revokes the older versions as active write targets. Old ciphertext still decrypts, because each `secret.EncryptedValue` keeps the version that was used when it was written.

That distinction is worth keeping in mind:

- **revocation** is the normal outcome of rotation
- **destruction** is what you use when the data must become permanently unreadable

For credentials, a common pattern is to rotate on replacement and destroy later when the integration is removed and you no longer need operational recovery of the old value.

## Rotate system keys deliberately

System-key rotation is separate from scope-key rotation.

When you mark a different key as active in the keyring, all *new* scope keys use that system key ID. Existing scope keys still point at whatever `system_key_id` was stored with them earlier. That means older ciphertext remains decryptable as long as the older system key is still available in the keyring.

```go
keyring, err := systemkey.NewKeyringFromFiles(systemkey.FileKeyConfig{
	KeyPaths: map[string]string{
		"2025-01": "/run/secrets/eventsalsa-system-key-2025-01",
		"2025-04": "/run/secrets/eventsalsa-system-key-2025-04",
	},
	ActiveKeyID: "2025-04",
})
```

In practice:

- changing `ActiveKeyID` affects new `CreateKey(...)` and `RotateKey(...)` calls
- it does **not** re-encrypt scope keys that are already stored
- you should not retire an older system key until every scope key that depends on it has either been replaced or intentionally destroyed

If you are protecting PII with non-rotating scoped keys, that last point matters even more. The package gives you clean system-key selection, but it does not currently provide a built-in DEK rewrap API.

## Use hashing for sensitive lookups

Some values should be searchable without being readable. That is where the module's HMAC hasher fits.

```go
emailHash := security.Hasher.Hash(email)
```

A keyed hash is useful for cases such as:

- uniqueness checks on an email address
- locating a user by a sensitive identifier
- joining to a read model without storing the cleartext value as an index key

Keep the HMAC key separate from your system keys. It solves a different problem.

## Bring your own cipher or key store

The package stays deliberately small at the edges. If you need a different cipher or a different persistence backend, you can swap those pieces out without changing the higher-level flow.

For a custom cipher, implement `cipher.Cipher` and pass it through `encryption.Config` or `encryption.WithCipher(...)`. For a custom key store, implement `keystore.KeyStore` and keep the same `(scope, scopeID, version)` semantics.

That makes `eventsalsa/encryption` a practical default rather than a hard dependency on one storage model. The important part is the lifecycle discipline around your keys, not whether the DEKs happen to live in PostgreSQL.
