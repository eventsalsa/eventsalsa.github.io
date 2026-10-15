---
title: Encryption
description: Secure event payloads with pure in-memory envelope encryption, stateless PostgreSQL key management, GDPR crypto-shredding, and key rotation.
---

`eventsalsa/encryption` provides envelope encryption and key management for event-sourced systems in Go.

In event-sourced architectures, event stores are append-only and immutable. Once sensitive data—such as personally identifiable information (PII) or operational credentials—is written to an event log in cleartext, removing or altering it later requires rewriting history. `eventsalsa/encryption` addresses this challenge with a decoupled two-tier encryption model that supports GDPR crypto-shredding, secret key rotation, system key rewrapping, and deterministic blind indexing.

`eventsalsa/encryption` is completely standalone. It does not depend on `eventsalsa/store` or `eventsalsa/projector`, making it easy to integrate into existing database workflows, event sourcing frameworks, or custom storage layers.

:::caution
Decide how sensitive fields will be protected before an event schema is deployed to production. Because event streams are immutable, changing encryption strategies after cleartext data has been persisted is expensive and complex.
:::

## How envelope encryption works

Envelope encryption protects application data using a two-tier key hierarchy:

1. **System Keys (KEKs — Key Encrypting Keys)**: Long-lived master keys managed in memory or loaded from secret stores (such as HashiCorp Vault, AWS KMS, or local secret mounts). System keys protect Data Encryption Keys.
2. **Data Encryption Keys (DEKs — Scope Keys)**: Ephemeral symmetric keys generated per `(scope, scopeID)` namespace (e.g., `("user_pii", "user-123")` or `("integration", "stripe-token")`). DEKs protect application payloads and are stored encrypted in PostgreSQL.

The runtime flow is split cleanly between key management and cryptographic transformations:

- **Encrypt**:
  1. Fetch or create the active encrypted DEK from `postgres.Store` using your database connection or transaction.
  2. Pass the encrypted DEK and plaintext to `envelope.Envelope.Encrypt`.
  3. The envelope engine unwraps the DEK in RAM using the matching system key from `systemkey.Keyring`, encrypts the plaintext with AES-256-GCM, immediately scrubs the plaintext DEK from memory, and returns a standard base64-encoded ciphertext.
- **Decrypt**:
  1. Fetch the encrypted DEK for the required version from `postgres.Store`.
  2. Pass the encrypted DEK and ciphertext to `envelope.Envelope.Decrypt`.
  3. The envelope engine unwraps the DEK in RAM, decrypts the ciphertext, zeroes the plaintext DEK, and returns the cleartext string.

| Layer | What it protects | Where it lives |
| --- | --- | --- |
| **System Key (KEK)** | Data Encryption Keys (DEKs) | `systemkey.Keyring` (Vault, KMS, secret files) |
| **Scope Key (DEK)** | Application payload | PostgreSQL keystore (`postgres.Store`) |
| **Ciphertext** | Sensitive business fields | Event payloads, database tables, or messages |

### Package overview

| Package | Role |
| :--- | :--- |
| `github.com/eventsalsa/encryption` | Root sentinel errors (`ErrKeyNotFound`, `ErrKeyExists`, etc.) and `ZeroBytes` memory scrubbing |
| `github.com/eventsalsa/encryption/cipher` | `Cipher` interface for symmetric encryption algorithms |
| `github.com/eventsalsa/encryption/cipher/aesgcm` | Default AES-256-GCM authenticated cipher implementation |
| `github.com/eventsalsa/encryption/systemkey` | `Keyring` interface, in-memory and file-based system key loaders |
| `github.com/eventsalsa/encryption/envelope` | `Envelope` — pure in-memory envelope encrypt/decrypt and DEK wrapping engine |
| `github.com/eventsalsa/encryption/postgres` | Stateless PostgreSQL `Store` and administrative `RewrapSystemKeys` utility |
| `github.com/eventsalsa/encryption/postgres/migrations` | Migration SQL generator and embedded schema definitions |
| `github.com/eventsalsa/encryption/hash` | `Hasher` interface and HMAC-SHA256 blind indexing implementation |

## Installation

Install the package using `go get`:

```bash
go get github.com/eventsalsa/encryption
go get github.com/jackc/pgx/v5
```

The library requires Go 1.24+ and has zero external dependencies beyond `pgx/v5`.

## Database migration

The PostgreSQL keystore requires a dedicated table to persist encrypted DEKs. Generate the migration SQL using the `migrate-gen` CLI:

```bash
go run github.com/eventsalsa/encryption/cmd/migrate-gen -output ./migrations
```

This generates a timestamped migration file (e.g., `migrations/20260831120000_init_encryption_keys.sql`).

You can customize the filename or print the migration directly to standard output:

```bash
# Output with a specific filename
go run github.com/eventsalsa/encryption/cmd/migrate-gen -output ./migrations -filename 003_encryption_keys.sql

# Print SQL directly to stdout
go run github.com/eventsalsa/encryption/cmd/migrate-gen -stdout

# Apply custom schema and table names
go run github.com/eventsalsa/encryption/cmd/migrate-gen -schema custom_infra -table custom_keys -stdout
```

The default schema is `infrastructure` and the default table name is `encryption_keys`.

You can also render the migration SQL programmatically using `postgres/migrations`:

```go
package main

import (
	"fmt"
	"log"

	"github.com/eventsalsa/encryption/postgres"
	"github.com/eventsalsa/encryption/postgres/migrations"
)

func main() {
	sql, err := migrations.SQL(postgres.DefaultConfig())
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(sql)
}
```

## System keyrings

System keys (KEKs) must be 32 bytes (256 bits).

For local development or secret mounts, generate a base64-encoded 32-byte key:

```bash
mkdir -p .secrets
openssl rand -base64 32 > .secrets/eventsalsa-system-key-2026-01
```

Load system keys from file paths using `systemkey.NewKeyringFromFiles`:

```go
package main

import (
	"log"

	"github.com/eventsalsa/encryption/systemkey"
)

func initKeyring() systemkey.Keyring {
	keyring, err := systemkey.NewKeyringFromFiles(systemkey.FileKeyConfig{
		KeyPaths: map[string]string{
			"key-2026-01": ".secrets/eventsalsa-system-key-2026-01",
		},
		ActiveKeyID: "key-2026-01",
	})
	if err != nil {
		log.Fatalf("failed to load system keys: %v", err)
	}
	return keyring
}
```

Alternatively, initialize an in-memory keyring directly from raw bytes:

```go
keyring := systemkey.NewKeyring(
	map[string][]byte{
		"key-2026-01": raw32ByteSlice,
	},
	"key-2026-01",
)
```

:::note
Never commit system key files or hardcoded raw keys to version control. Load key material from environment variables, secret managers, or protected filesystem mounts.
:::

## Basic setup and usage

The components are composed explicitly: create a `systemkey.Keyring` and a `cipher.Cipher`, instantiate the in-memory `envelope.Envelope` engine, and pass it to `postgres.NewStore`.

```go
package main

import (
	"context"
	"log"

	"github.com/eventsalsa/encryption/cipher/aesgcm"
	"github.com/eventsalsa/encryption/envelope"
	"github.com/eventsalsa/encryption/postgres"
	"github.com/eventsalsa/encryption/systemkey"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, "postgres://postgres:postgres@localhost:5432/eventsalsa?sslmode=disable")
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	// 1. Initialize Keyring & Cipher
	keyring := systemkey.NewKeyring(
		map[string][]byte{
			"key-2026-01": []byte("01234567890123456789012345678901"), // 32 bytes
		},
		"key-2026-01",
	)
	c := aesgcm.New()

	// 2. Initialize in-memory Envelope & stateless PostgreSQL Store
	env := envelope.New(keyring, c)
	store := postgres.NewStore(env, postgres.DefaultConfig())

	scope, scopeID := "user_pii", "user-123"

	// 3. Create a DEK for this scope (inserts version 1 into PostgreSQL)
	version, err := store.CreateKey(ctx, pool, scope, scopeID)
	if err != nil {
		log.Fatalf("failed to create key: %v", err)
	}
	log.Printf("created DEK version %d", version)

	// 4. Fetch the active key
	key, err := store.GetActiveKey(ctx, pool, scope, scopeID)
	if err != nil {
		log.Fatalf("failed to fetch active key: %v", err)
	}

	// 5. Encrypt plaintext in-memory (no database I/O)
	ciphertext, err := env.Encrypt(key.SystemKeyID, key.EncryptedDEK, "alice@example.com")
	if err != nil {
		log.Fatalf("encryption failed: %v", err)
	}
	log.Printf("ciphertext: %s", ciphertext)

	// 6. Decrypt ciphertext in-memory
	plaintext, err := env.Decrypt(key.SystemKeyID, key.EncryptedDEK, ciphertext)
	if err != nil {
		log.Fatalf("decryption failed: %v", err)
	}
	log.Printf("decrypted: %s", plaintext)
}
```

Notice the division of responsibilities:
- `postgres.Store` handles DEK persistence, versioning, revocation, and deletion in PostgreSQL.
- `envelope.Envelope` handles pure in-memory encryption, decryption, and key unwrapping with zero database or context dependencies.

## Transaction participation

In event-sourced applications, creating a DEK and appending the resulting event must happen inside the same database transaction.

`postgres.Store` is stateless and does not hold an internal connection pool. All CRUD methods accept any database executor satisfying the standard pgx interface (`*pgxpool.Pool`, `pgx.Tx`, or `*pgx.Conn`). This lets you pass an active transaction directly into store operations:

```go
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/eventsalsa/encryption"
	"github.com/eventsalsa/encryption/envelope"
	encpostgres "github.com/eventsalsa/encryption/postgres"
	"github.com/eventsalsa/store"
)

type UserRegisteredPayload struct {
	Email string `json:"email"`
}

func RegisterUser(
	ctx context.Context,
	pool *pgxpool.Pool,
	env *envelope.Envelope,
	keyStore *encpostgres.Store,
	eventStore store.EventStore,
	userID, email string,
) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	scope := "user_pii"

	// 1. Key creation runs inside the transaction
	key, err := keyStore.GetActiveKey(ctx, tx, scope, userID)
	if errors.Is(err, encryption.ErrKeyNotFound) {
		if _, err := keyStore.CreateKey(ctx, tx, scope, userID); err != nil {
			return fmt.Errorf("create key: %w", err)
		}
		key, err = keyStore.GetActiveKey(ctx, tx, scope, userID)
	}
	if err != nil {
		return fmt.Errorf("resolve active key: %w", err)
	}

	// 2. Encrypt payload in-memory (zero database access)
	encryptedEmail, err := env.Encrypt(key.SystemKeyID, key.EncryptedDEK, email)
	if err != nil {
		return fmt.Errorf("encrypt email: %w", err)
	}

	payload, err := json.Marshal(UserRegisteredPayload{Email: encryptedEmail})
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	// 3. Append the event to eventsalsa/store in the exact same transaction
	event := store.Event{
		StreamType:   "User",
		StreamID:     userID,
		EventID:      uuid.New(),
		EventType:    "UserRegistered",
		EventVersion: 1,
		Payload:      payload,
		Metadata:     []byte(`{}`),
		CreatedAt:    time.Now().UTC(),
	}

	if _, err := eventStore.Append(ctx, tx, store.NoStream(), []store.Event{event}); err != nil {
		return fmt.Errorf("append event to store: %w", err)
	}

	return tx.Commit(ctx)
}
```

If the transaction rolls back at any point, both the DEK insertion and the event record are discarded cleanly together.

## Domain modeling with encrypted values

To preserve clean architectural boundaries, keep domain models independent of infrastructure encryption packages. Aggregates should receive already-encrypted values or emit events containing custom domain types.

### Define domain value types

Define strong types for sensitive fields inside your domain package:

```go
package user

type EncryptedEmail string
type EncryptedFullName string

type UserRegistered struct {
	UserID    string
	Email     EncryptedEmail
	FullName  EncryptedFullName
	EmailHash string
}

type UserDeleted struct {
	UserID string
}

type User struct {
	id          string
	uncommitted []any
}

func Register(userID string, email EncryptedEmail, name EncryptedFullName, emailHash string) *User {
	u := &User{id: userID}
	u.uncommitted = append(u.uncommitted, UserRegistered{
		UserID:    userID,
		Email:     email,
		FullName:  name,
		EmailHash: emailHash,
	})
	return u
}

func (u *User) Delete() {
	u.uncommitted = append(u.uncommitted, UserDeleted{UserID: u.id})
}

func (u *User) UncommittedEvents() []any { return u.uncommitted }
func (u *User) ClearUncommittedEvents()   { u.uncommitted = nil }
```

### Coordinate encryption in application services

The application service coordinates key lifecycle, in-memory encryption, aggregate creation, and repository persistence:

```go
package app

import (
	"context"
	"fmt"

	"github.com/acme/shop/internal/domain/user"
	"github.com/eventsalsa/encryption/envelope"
	"github.com/eventsalsa/encryption/hash"
	"github.com/eventsalsa/encryption/postgres"
	"github.com/jackc/pgx/v5"
)

type UserRepository interface {
	Save(ctx context.Context, tx pgx.Tx, aggregate *user.User) error
}

type RegistrationService struct {
	users  UserRepository
	env    *envelope.Envelope
	store  *postgres.Store
	hasher hash.Hasher
}

func NewRegistrationService(
	users UserRepository,
	env *envelope.Envelope,
	store *postgres.Store,
	hasher hash.Hasher,
) *RegistrationService {
	return &RegistrationService{
		users:  users,
		env:    env,
		store:  store,
		hasher: hasher,
	}
}

func (s *RegistrationService) Register(ctx context.Context, tx pgx.Tx, userID, email, name string) error {
	scope := "user_pii"

	// 1. Ensure the user's DEK exists in PostgreSQL
	if _, err := s.store.CreateKey(ctx, tx, scope, userID); err != nil {
		return fmt.Errorf("create user dek: %w", err)
	}

	key, err := s.store.GetActiveKey(ctx, tx, scope, userID)
	if err != nil {
		return fmt.Errorf("get active dek: %w", err)
	}

	// 2. Encrypt sensitive fields in RAM
	encEmail, err := s.env.Encrypt(key.SystemKeyID, key.EncryptedDEK, email)
	if err != nil {
		return fmt.Errorf("encrypt email: %w", err)
	}

	encName, err := s.env.Encrypt(key.SystemKeyID, key.EncryptedDEK, name)
	if err != nil {
		return fmt.Errorf("encrypt name: %w", err)
	}

	// 3. Compute deterministic blind index for lookups
	emailHash := s.hasher.Hash(email)

	// 4. Instantiate domain aggregate with encrypted value objects
	aggregate := user.Register(
		userID,
		user.EncryptedEmail(encEmail),
		user.EncryptedFullName(encName),
		emailHash,
	)

	// 5. Persist aggregate uncommitted events to eventsalsa/store
	return s.users.Save(ctx, tx, aggregate)
}
```

### Persist domain events with `eventsalsa/store`

The repository adapter transforms uncommitted domain events into `store.Event` envelopes and appends them to `eventsalsa/store` inside the active transaction:

```go
package persistence

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/acme/shop/internal/domain/user"
	"github.com/eventsalsa/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type PostgresUserRepository struct {
	eventStore store.EventStore
}

func NewPostgresUserRepository(eventStore store.EventStore) *PostgresUserRepository {
	return &PostgresUserRepository{eventStore: eventStore}
}

func (r *PostgresUserRepository) Save(ctx context.Context, tx pgx.Tx, u *user.User) error {
	events := make([]store.Event, 0, len(u.UncommittedEvents()))

	for _, uncommitted := range u.UncommittedEvents() {
		switch evt := uncommitted.(type) {
		case user.UserRegistered:
			payload, err := json.Marshal(evt)
			if err != nil {
				return fmt.Errorf("marshal UserRegistered: %w", err)
			}

			events = append(events, store.Event{
				StreamType:   "User",
				StreamID:     evt.UserID,
				EventID:      uuid.New(),
				EventType:    "UserRegistered",
				EventVersion: 1,
				Payload:      payload,
				Metadata:     []byte(`{}`),
				CreatedAt:    time.Now().UTC(),
			})
		}
	}

	if _, err := r.eventStore.Append(ctx, tx, store.NoStream(), events); err != nil {
		return fmt.Errorf("append to event store: %w", err)
	}

	u.ClearUncommittedEvents()
	return nil
}
```

## Projections and read models

Encrypted payloads in the event store are not directly queryable. In event sourcing, you build read models (projections) optimized for specific query patterns.

When projecting events containing encrypted fields, fetch the DEK, decrypt the payload in-memory, and insert cleartext into the read model table:

```sql
CREATE TABLE read_model.user_directory_v1 (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    email_hash TEXT NOT NULL UNIQUE,
    last_global_position BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_user_directory_v1_email_hash
    ON read_model.user_directory_v1 (email_hash);
```

The projection handler decrypts the event and updates the read model table idempotently:

```go
package projections

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/eventsalsa/encryption/envelope"
	"github.com/eventsalsa/encryption/postgres"
	"github.com/eventsalsa/store"
	"github.com/jackc/pgx/v5"
)

type UserRegisteredPayload struct {
	UserID    string `json:"user_id"`
	Email     string `json:"email"`
	FullName  string `json:"full_name"`
	EmailHash string `json:"email_hash"`
}

type UserDirectoryProjection struct {
	env   *envelope.Envelope
	store *postgres.Store
}

func NewUserDirectoryProjection(env *envelope.Envelope, store *postgres.Store) *UserDirectoryProjection {
	return &UserDirectoryProjection{env: env, store: store}
}

func (p *UserDirectoryProjection) Name() string {
	return "user_directory_v1"
}

func (p *UserDirectoryProjection) Handle(ctx context.Context, tx pgx.Tx, event store.PersistedEvent) error {
	switch event.EventType {
	case "UserRegistered":
		var payload UserRegisteredPayload
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return fmt.Errorf("unmarshal event payload: %w", err)
		}

		// 1. Fetch DEK
		key, err := p.store.GetActiveKey(ctx, tx, "user_pii", payload.UserID)
		if err != nil {
			return fmt.Errorf("fetch dek: %w", err)
		}

		// 2. Decrypt fields in-memory
		email, err := p.env.Decrypt(key.SystemKeyID, key.EncryptedDEK, payload.Email)
		if err != nil {
			return fmt.Errorf("decrypt email: %w", err)
		}

		name, err := p.env.Decrypt(key.SystemKeyID, key.EncryptedDEK, payload.FullName)
		if err != nil {
			return fmt.Errorf("decrypt name: %w", err)
		}

		// 3. Upsert into read model with position guard
		_, err = tx.Exec(ctx, `
			INSERT INTO read_model.user_directory_v1 (
				user_id, email, full_name, email_hash, last_global_position
			)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (user_id) DO UPDATE
			SET email = EXCLUDED.email,
			    full_name = EXCLUDED.full_name,
			    email_hash = EXCLUDED.email_hash,
			    last_global_position = EXCLUDED.last_global_position
			WHERE read_model.user_directory_v1.last_global_position < EXCLUDED.last_global_position
		`, payload.UserID, email, name, payload.EmailHash, event.GlobalPosition)
		return err

	case "UserDeleted":
		_, err := tx.Exec(ctx, `
			DELETE FROM read_model.user_directory_v1
			WHERE user_id = $1
		`, event.StreamID)
		return err
	}

	return nil
}
```

This projection can run synchronously inside the append transaction or asynchronously via `eventsalsa/projector`.

## GDPR crypto-shredding (Right to Erasure)

Under privacy regulations like GDPR (Article 17 — Right to Erasure), users have the right to request deletion of their personal data. In an append-only event store, deleting or updating past events violates immutability and invalidates stream integrity.

Crypto-shredding solves this problem:

1. Each subject is assigned a unique DEK (e.g., `scope="user_pii", scopeID=userID`).
2. When an erasure request is processed, the DEK is permanently deleted from PostgreSQL via `store.DestroyKeys`.
3. Without the DEK, historical events remain in the event store but are **permanently and mathematically undecryptable**.

```go
package app

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/eventsalsa/encryption/postgres"
	"github.com/eventsalsa/store"
)

func HandleErasureRequest(
	ctx context.Context,
	pool *pgxpool.Pool,
	keyStore *postgres.Store,
	eventStore store.EventStore,
	userID string,
	currentStreamVersion int64,
) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// 1. Permanently delete the DEK from PostgreSQL (crypto-shredding)
	if err := keyStore.DestroyKeys(ctx, tx, "user_pii", userID); err != nil {
		return fmt.Errorf("destroy pii keys: %w", err)
	}

	// 2. Append UserDeleted event to eventsalsa/store to record the domain fact
	deleteEvent := store.Event{
		StreamType:   "User",
		StreamID:     userID,
		EventID:      uuid.New(),
		EventType:    "UserDeleted",
		EventVersion: 1,
		Payload:      []byte(`{}`),
		Metadata:     []byte(`{}`),
		CreatedAt:    time.Now().UTC(),
	}

	if _, err := eventStore.Append(ctx, tx, store.Exact(currentStreamVersion), []store.Event{deleteEvent}); err != nil {
		return fmt.Errorf("append delete event: %w", err)
	}

	return tx.Commit(ctx)
}
```

After `DestroyKeys` runs:
- The DEK row is hard-deleted from PostgreSQL (`DELETE`, not a soft revocation).
- Any subsequent attempt to call `store.GetActiveKey` or `store.GetKey` returns `encryption.ErrKeyNotFound`.
- Full stream replays encountering past PII payloads cannot decrypt them, ensuring personal data is unrecoverable.

:::caution
Revocation (`store.RevokeKeys`) is insufficient for GDPR compliance because revoked keys remain stored in the database for historical audit decryption. Complete erasure requires `store.DestroyKeys`.
:::

## Secret rotation and historical retention

Unlike user PII (which is pinned to one DEK and crypto-shredded upon deletion), operational secrets (such as API keys, OAuth tokens, and webhook secrets) need periodic rotation (e.g., every 90 days) while retaining the ability to decrypt historical audit trails.

### The rotation workflow

1. Create version 1 of the secret's DEK: `store.CreateKey(ctx, pool, "api_token", "stripe")`.
2. Encrypt payloads under version 1.
3. When rotating credentials, call `store.RotateKey(ctx, pool, "api_token", "stripe")`:
   - Generates a new random DEK.
   - Inserts version 2 into PostgreSQL.
   - Soft-revokes version 1 by setting `revoked_at = NOW()`.
4. New writes automatically fetch version 2 via `store.GetActiveKey`.
5. Historical records encrypted under version 1 remain decryptable by explicitly fetching version 1 with `store.GetKey(ctx, pool, "api_token", "stripe", 1)`.

```go
package app

import (
	"context"
	"fmt"
	"log"

	"github.com/eventsalsa/encryption/envelope"
	"github.com/eventsalsa/encryption/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

func RotateSecretExample(ctx context.Context, pool *pgxpool.Pool, env *envelope.Envelope, store *postgres.Store) error {
	scope, secretID := "api_token", "stripe_production"

	// 1. Initial creation (Version 1)
	v1, err := store.CreateKey(ctx, pool, scope, secretID)
	if err != nil {
		return err
	}
	keyV1, _ := store.GetActiveKey(ctx, pool, scope, secretID)
	cipherV1, _ := env.Encrypt(keyV1.SystemKeyID, keyV1.EncryptedDEK, "sk_live_v1_initial_secret")
	log.Printf("created version %d, encrypted payload: %s", v1, cipherV1)

	// 2. Rotate to Version 2 (generates new DEK, revokes v1)
	v2, err := store.RotateKey(ctx, pool, scope, secretID)
	if err != nil {
		return err
	}
	keyV2, _ := store.GetActiveKey(ctx, pool, scope, secretID)
	cipherV2, _ := env.Encrypt(keyV2.SystemKeyID, keyV2.EncryptedDEK, "sk_live_v2_rotated_secret")
	log.Printf("rotated to version %d, encrypted payload: %s", v2, cipherV2)

	// 3. Historical audit read: decrypt v1 using specific version lookup
	histKeyV1, err := store.GetKey(ctx, pool, scope, secretID, 1)
	if err != nil {
		return err
	}
	decryptedV1, _ := env.Decrypt(histKeyV1.SystemKeyID, histKeyV1.EncryptedDEK, cipherV1)
	log.Printf("historical v1 decrypted: %s (revoked at: %v)", decryptedV1, histKeyV1.RevokedAt)

	// 4. Active read: decrypt v2 using active key
	decryptedV2, _ := env.Decrypt(keyV2.SystemKeyID, keyV2.EncryptedDEK, cipherV2)
	log.Printf("active v2 decrypted: %s", decryptedV2)

	return nil
}
```

## System key (KEK) rotation and rewrapping

When rotating system-level master keys (KEKs), new writes must use the new system key, and existing DEKs stored under the old system key must be re-encrypted.

`postgres.RewrapSystemKeys` is a standalone administrative function that rewraps stored DEKs in place without rotating DEKs or re-encrypting application payloads.

### Recommended rewrap sequence

1. **Provision the new key**: Load both the old and new system keys into `systemkey.Keyring`, and mark the new key ID as active:
   ```go
   keyring, err := systemkey.NewKeyringFromFiles(systemkey.FileKeyConfig{
   	KeyPaths: map[string]string{
   		"key-2025-01": ".secrets/key-2025-01",
   		"key-2026-01": ".secrets/key-2026-01",
   	},
   	ActiveKeyID: "key-2026-01",
   })
   ```
2. **Execute a dry run**: Preview the number of rows requiring migration:
   ```go
   c := aesgcm.New()
   preview, err := postgres.RewrapSystemKeys(ctx, pool, postgres.DefaultConfig(), keyring, c, postgres.RewrapSystemKeysOptions{
   	FromSystemKeyID: "key-2025-01",
   	ToSystemKeyID:   "key-2026-01",
   	BatchSize:       500,
   	DryRun:          true,
   })
   if err != nil {
       log.Fatalf("dry run failed: %v", err)
   }
   log.Printf("matched rows to rewrap: %d", preview.MatchedRows)
   ```
3. **Execute the batch rewrap**: Run the rewrap until `RemainingRows` reaches zero:
   ```go
   result, err := postgres.RewrapSystemKeys(ctx, pool, postgres.DefaultConfig(), keyring, c, postgres.RewrapSystemKeysOptions{
   	FromSystemKeyID: "key-2025-01",
   	ToSystemKeyID:   "key-2026-01",
   	BatchSize:       500,
   })
   if err != nil {
       log.Fatalf("rewrap failed: %v", err)
   }
   log.Printf("rewrapped=%d skipped=%d remaining=%d batches=%d",
   	result.RewrappedRows, result.SkippedRows, result.RemainingRows, result.Batches)
   ```
4. **Decommission the old key**: Once `RemainingRows` is verified to be 0 across all environments, remove the old key from configuration.

### How rewrap operates

- Runs in short, PostgreSQL-managed batch transactions using `FOR UPDATE SKIP LOCKED`.
- Re-encrypts only the stored `encrypted_key` and updates `system_key_id`.
- Covers both active and soft-revoked rows.
- Does not modify `key_version`, create new rows, or touch application ciphertext.

## Deterministic blind indexing (HMAC hashing)

Because AES-256-GCM uses random nonces for every encryption call, encrypting the same plaintext twice produces different ciphertexts. This prevents direct SQL equality queries (`WHERE email = $1`) and unique constraints.

`hash.HMACHasher` provides deterministic blind indexing using HMAC-SHA256:

```go
package main

import (
	"fmt"

	"github.com/eventsalsa/encryption/hash"
)

func main() {
	// Secret key dedicated to HMAC blind indexing (separate from system KEKs)
	hmacKey := []byte("secret-hmac-key-min-32-bytes-long")
	hasher := hash.NewHMACHasher(hmacKey)

	// Hash plaintext to a deterministic hex digest
	digest1 := hasher.Hash("alice@example.com")
	digest2 := hasher.Hash("alice@example.com")

	fmt.Println("Digest 1:", digest1)
	fmt.Println("Digest 2:", digest2)
	fmt.Println("Equal:", digest1 == digest2) // true
}
```

Use deterministic hashes for:
- Enforcing uniqueness constraints in database tables (e.g., `email_hash TEXT UNIQUE`).
- Locating records by sensitive identifiers without storing plaintext.
- Generating deterministic aggregate IDs from sensitive keys.

:::note
Keep the HMAC secret key separate from system KEKs. The HMAC key must remain stable for queries to resolve accurately across restarts.
:::

## Pluggable ciphers and memory hygiene

### Pluggable symmetric cipher

`eventsalsa/encryption` defaults to AES-256-GCM (`cipher/aesgcm`), but you can supply any symmetric algorithm by implementing the `cipher.Cipher` interface:

```go
package cipher

type Cipher interface {
	Encrypt(key, plaintext []byte) ([]byte, error)
	Decrypt(key, ciphertext []byte) ([]byte, error)
	KeySize() int
}
```

Pass your custom cipher directly into `envelope.New(keyring, customCipher)`.

### Memory hygiene

Whenever a DEK is unwrapped or generated in memory, plaintext key bytes must not linger in the Go runtime heap longer than necessary.

`envelope.Envelope` internally zeroes DEK byte slices immediately after encryption or decryption using `encryption.ZeroBytes`. If you work directly with unwrapped DEK buffers via `envelope.UnwrapDEK` or `envelope.GenerateDEK`, always defer memory scrubbing:

```go
dek, err := env.UnwrapDEK(sysKeyID, encDEK)
if err != nil {
	return err
}
defer encryption.ZeroBytes(dek)
```

### Sentinel errors

All packages return shared sentinel errors defined in root `github.com/eventsalsa/encryption`:

| Sentinel Error | Description |
| :--- | :--- |
| `encryption.ErrKeyNotFound` | The requested encryption key was not found in the keystore. |
| `encryption.ErrKeyExists` | A key for the specified `(scope, scopeID)` already exists during `CreateKey`. |
| `encryption.ErrEncryption` | Symmetric encryption operation failed. |
| `encryption.ErrDecryption` | Symmetric decryption or authentication tag verification failed. |
| `encryption.ErrInvalidKeySize` | Provided key size does not match the cipher's requirement. |
| `encryption.ErrKeyRevoked` | The requested key version has been soft-revoked. |
| `encryption.ErrKeyDestroyed` | The key has been permanently destroyed. |
