---
title: Encryption
description: Secure event payloads with KMS-native envelope encryption, stateless PostgreSQL key management, GDPR crypto-shredding, and key rotation.
---

`eventsalsa/encryption` provides KMS-native envelope encryption and key management for event-sourced systems in Go.

In event-sourced architectures, event stores are append-only and immutable. Once sensitive data—such as personally identifiable information (PII) or operational credentials—is written to an event log in cleartext, removing or altering it later requires rewriting history. `eventsalsa/encryption` addresses this challenge with a decoupled two-tier encryption model that supports Cloud KMS and local Key Encryption Keys (KEKs), GDPR crypto-shredding, secret key rotation, batch KEK rewrapping, and deterministic blind indexing.

`eventsalsa/encryption` is completely standalone. It does not depend on `eventsalsa/store` or `eventsalsa/projector`, making it easy to integrate into existing database workflows, event sourcing frameworks, or custom storage layers.

:::caution
Decide how sensitive fields will be protected before an event schema is deployed to production. Because event streams are immutable, changing encryption strategies after cleartext data has been persisted is expensive and complex.
:::

## How envelope encryption works

Envelope encryption protects application data using a two-tier key hierarchy:

1. **Key Encryption Keys (KEKs)**: Long-lived master keys managed via `kek.Wrapper` and `kek.Keyring`. KEKs can reside inside Cloud KMS providers (**AWS KMS** or **Google Cloud KMS**) where raw key material never leaves the hardware security boundary, or in local process memory (`kek/local`) loaded from secret mounts. KEKs wrap and unwrap Data Encryption Keys.
2. **Data Encryption Keys (DEKs — Scope Keys)**: Symmetric 256-bit keys generated per `(scope, scopeID)` namespace (e.g., `("user_pii", "user-123")` or `("api_token", "stripe")`). Each wrapped DEK is cryptographically bound to its `(scope, scopeID, keyVersion)` tuple via canonical Additional Authenticated Data (`KeyScope.AAD()`) and stored in PostgreSQL (`postgres.Store`).

The runtime flow separates key persistence, KEK wrapping, and local symmetric AEAD encryption:

- **Key creation (`postgres.Store.CreateKey`)**:
  1. Generates a random 256-bit DEK in memory.
  2. Wraps the DEK using the active KEK in `kek.Keyring`, binding `KeyScope{Scope, ScopeID, KeyVersion: 1}.AAD()` into the authentication tag so the wrapped DEK cannot be transplanted across database rows.
  3. Zeroes the plaintext DEK in RAM and persists the wrapped `encryption.EncryptedKey` in PostgreSQL.
- **Encrypting and decrypting payloads (`envelope.Envelope` & `envelope.Session`)**:
  1. Fetch or create the `*encryption.EncryptedKey` from `postgres.Store` using your `pgx` pool, connection, or transaction.
  2. For single-value operations, call `env.Encrypt` / `env.Decrypt` (for `[]byte`) or `env.EncryptString` / `env.DecryptString` (for base64-encoded UTF-8 strings).
  3. For multi-field or multi-event operations, open a reusable session with `env.OpenSession(ctx, key)` to unwrap the DEK once, perform multiple local AES-256-GCM operations in memory with zero additional KMS calls, and scrub the DEK with `defer session.Close()`.

| Layer | What it protects | Where it lives |
| --- | --- | --- |
| **Key Encryption Key (KEK)** | Data Encryption Keys (DEKs) | `kek.Keyring` (`kek/awskms`, `kek/gcpkms`, or `kek/local`) |
| **Data Encryption Key (DEK)** | Application payloads | PostgreSQL keystore (`postgres.Store`), wrapped by a KEK |
| **Ciphertext** | Sensitive business fields | Event payloads, database tables, or messages |

### Package overview

| Package | Role |
| :--- | :--- |
| `github.com/eventsalsa/encryption` | Root sentinel errors, `EncryptedKey`, `KeyScope` (with canonical `AAD()`), and `ZeroBytes` memory scrubbing |
| `github.com/eventsalsa/encryption/cipher` | `Cipher` AEAD interface with `aad []byte` support |
| `github.com/eventsalsa/encryption/cipher/aesgcm` | Default AES-256-GCM authenticated cipher implementation |
| `github.com/eventsalsa/encryption/kek` | `Wrapper`, `Rewrapper`, `Keyring`, and bounded TTL + LRU `CachingKeyring` decorator |
| `github.com/eventsalsa/encryption/kek/local` | In-process AES-256-GCM `Wrapper` and in-memory / file-based `Keyring` loaders |
| `github.com/eventsalsa/encryption/kek/awskms` | AWS KMS `Wrapper` and server-side `kms:ReEncrypt` `Rewrapper` (separate Go sub-module) |
| `github.com/eventsalsa/encryption/kek/gcpkms` | Google Cloud KMS `Wrapper` with end-to-end CRC32C integrity verification (separate Go sub-module) |
| `github.com/eventsalsa/encryption/envelope` | `Envelope` engine and reusable in-memory `Session` handles |
| `github.com/eventsalsa/encryption/postgres` | Stateless PostgreSQL `Store` and batch `RewrapKeys` administrative utility |
| `github.com/eventsalsa/encryption/postgres/migrations` | Migration SQL generator and embedded schema definitions |
| `github.com/eventsalsa/encryption/hash` | `Hasher` interface and HMAC-SHA256 blind indexing implementation |

## Installation

Install the core module and `pgx/v5`:

```bash
go get github.com/eventsalsa/encryption
go get github.com/jackc/pgx/v5
```

The root module keeps its dependency footprint minimal and free of cloud SDKs. If you use AWS KMS or Google Cloud KMS as your KEK provider, install the corresponding Go sub-module:

```bash
# Optional: AWS KMS KEK provider
go get github.com/eventsalsa/encryption/kek/awskms

# Optional: Google Cloud KMS KEK provider
go get github.com/eventsalsa/encryption/kek/gcpkms
```

## Database migration

The PostgreSQL keystore requires a dedicated table to persist wrapped DEKs. Generate the migration SQL using the `migrate-gen` CLI:

```bash
go run github.com/eventsalsa/encryption/cmd/migrate-gen -output ./migrations
```

This writes a timestamped migration file (for example, `migrations/20261015120000_init_encryption_keys.sql`).

You can also specify a custom filename, print the SQL to standard output, or override the target schema and table names:

```bash
# Output with a specific filename
go run github.com/eventsalsa/encryption/cmd/migrate-gen -output ./migrations -filename 003_encryption_keys.sql

# Print SQL directly to stdout
go run github.com/eventsalsa/encryption/cmd/migrate-gen -stdout

# Apply custom schema and table names
go run github.com/eventsalsa/encryption/cmd/migrate-gen -schema custom_infra -table custom_keys -stdout
```

The default schema is `infrastructure` and the default table name is `encryption_keys`.

To render the migration SQL programmatically in Go, use `postgres/migrations`:

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

`migrations.SQL` validates the schema and table names and returns the DDL for the `encryption_keys` table along with its active-key partial unique index and composite KEK rewrap index.

## Key Encryption Keys (KEKs) and keyrings

All KEK providers implement `kek.Wrapper` and are organized into a `kek.Keyring`. A keyring holds one active KEK (used to wrap newly created or rotated DEKs) and any number of historical KEKs (used to unwrap existing DEKs).

### Local KEKs (`kek/local`)

For local development or deployments using Kubernetes/Vault file mounts, `kek/local` wraps DEKs in-process using AES-256-GCM with 32-byte (256-bit) keys.

Generate a base64-encoded 32-byte key file:

```bash
mkdir -p .secrets
openssl rand -base64 32 > .secrets/kek-2026-01
```

Load local KEKs from files using `local.NewKeyringFromFiles`:

```go
package main

import (
	"log"

	"github.com/eventsalsa/encryption/kek"
	"github.com/eventsalsa/encryption/kek/local"
)

func initLocalKeyring() kek.Keyring {
	keyring, err := local.NewKeyringFromFiles(local.FileConfig{
		KeyPaths: map[string]string{
			"kek-2026-01": ".secrets/kek-2026-01",
		},
		ActiveKeyID: "kek-2026-01",
	})
	if err != nil {
		log.Fatalf("failed to load local KEKs: %v", err)
	}
	return keyring
}
```

You can also construct a local keyring directly from raw 32-byte slices in memory using `local.NewKeyringFromMap`:

```go
keyring, err := local.NewKeyringFromMap(
	map[string][]byte{
		"kek-2026-01": raw32ByteKey,
	},
	"kek-2026-01",
)
```

:::note
Never commit key files or hardcoded raw keys to version control. When shutting down an application using `kek/local`, call `Close()` on your `local.Wrapper` instances (or scrub raw input slices with `encryption.ZeroBytes`) so key bytes do not remain in memory.
:::

### AWS KMS (`kek/awskms`)

The `kek/awskms` sub-module wraps and unwraps DEKs using AWS KMS (`github.com/aws/aws-sdk-go-v2/service/kms`). The KEK never leaves AWS KMS, and the canonical `KeyScope.AAD()` is bound via the AWS KMS `EncryptionContext` map.

```go
package main

import (
	"context"
	"log"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/eventsalsa/encryption/kek"
	"github.com/eventsalsa/encryption/kek/awskms"
)

func initAWSKeyring(ctx context.Context) kek.Keyring {
	awsCfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("load aws config: %v", err)
	}

	kmsClient := kms.NewFromConfig(awsCfg)
	keyARN := "arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab"

	wrapper, err := awskms.NewWrapper(kmsClient, keyARN)
	if err != nil {
		log.Fatalf("create aws kms wrapper: %v", err)
	}

	keyring, err := kek.NewKeyring(keyARN, wrapper)
	if err != nil {
		log.Fatalf("create keyring: %v", err)
	}
	return keyring
}
```

By default, `awskms.Wrapper` stores base64-encoded AAD in `EncryptionContext` under `awskms.DefaultContextKey` (`"eventsalsa:aad"`). If your IAM policy conditions or CloudTrail conventions require a custom context key name, pass `awskms.WithContextKey`:

```go
wrapper, err := awskms.NewWrapper(
	kmsClient,
	keyARN,
	awskms.WithContextKey("acme:encryption_context"),
)
```

`awskms.Wrapper` also implements `kek.Rewrapper` using AWS KMS's server-side `ReEncrypt` API. When rotating from one AWS KMS key to another on the same client, DEKs are re-encrypted entirely inside AWS KMS without exposing plaintext DEKs to application memory.

### Google Cloud KMS (`kek/gcpkms`)

The `kek/gcpkms` sub-module wraps and unwraps DEKs using Google Cloud KMS (`cloud.google.com/go/kms/apiv1`). It binds `KeyScope.AAD()` via `AdditionalAuthenticatedData` and enforces end-to-end Castagnoli CRC32C checksum verification on both requests and responses.

```go
package main

import (
	"context"
	"log"

	kms "cloud.google.com/go/kms/apiv1"
	"github.com/eventsalsa/encryption/kek"
	"github.com/eventsalsa/encryption/kek/gcpkms"
)

func initGCPKeyring(ctx context.Context) (kek.Keyring, func() error) {
	kmsClient, err := kms.NewKeyManagementClient(ctx)
	if err != nil {
		log.Fatalf("create gcp kms client: %v", err)
	}

	keyName := "projects/my-project/locations/europe-west1/keyRings/eventsalsa/cryptoKeys/master-kek"

	wrapper, err := gcpkms.NewWrapper(kmsClient, keyName)
	if err != nil {
		log.Fatalf("create gcp kms wrapper: %v", err)
	}

	keyring, err := kek.NewKeyring(keyName, wrapper)
	if err != nil {
		log.Fatalf("create keyring: %v", err)
	}
	return keyring, kmsClient.Close
}
```

Every `Wrap` and `Unwrap` call computes CRC32C checksums over the plaintext, ciphertext, and AAD before calling Cloud KMS, verifies that the server checked the request checksums (`VerifiedPlaintextCrc32C`, `VerifiedAdditionalAuthenticatedDataCrc32C`), and validates the response checksum before returning.

### Caching unwrapped DEKs (`kek.CachingKeyring`)

When using a remote Cloud KMS provider, unwrapping the same DEK across repeated requests incurs network latency and KMS API costs. `kek.CachingKeyring` decorates any `kek.Keyring` with a concurrency-safe, bounded TTL + LRU in-memory cache of unwrapped DEKs:

```go
package main

import (
	"time"

	"github.com/eventsalsa/encryption/kek"
)

func withDEKCache(base kek.Keyring) (*kek.CachingKeyring, error) {
	return kek.NewCachingKeyring(base, kek.CacheConfig{
		TTL:        5 * time.Minute,
		MaxEntries: 1000,
	})
}
```

`CachingKeyring` keys entries by a SHA-256 digest of `(kekID, encryptedDEK, aad)`, returns defensive copies on every `Wrap` and `Unwrap` call so callers can safely scrub their own buffers, and automatically zeroes cached DEK bytes upon TTL expiration, LRU eviction, `Invalidate()`, or `Close()`. Always call `defer cachedKeyring.Close()` during application shutdown.

## Basic setup and usage

Compose the components by creating a `kek.Keyring` and a `cipher.Cipher`, wiring them into `envelope.Envelope`, and passing the envelope engine to `postgres.NewStore`:

```go
package main

import (
	"context"
	"log"

	"github.com/eventsalsa/encryption/cipher/aesgcm"
	"github.com/eventsalsa/encryption/envelope"
	"github.com/eventsalsa/encryption/kek/local"
	"github.com/eventsalsa/encryption/postgres"
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
	keyring, err := local.NewKeyringFromMap(
		map[string][]byte{
			"kek-2026-01": []byte("01234567890123456789012345678901"), // 32 bytes
		},
		"kek-2026-01",
	)
	if err != nil {
		log.Fatal(err)
	}
	c := aesgcm.New()

	// 2. Initialize Envelope & stateless PostgreSQL Store
	env := envelope.New(keyring, c)
	store := postgres.NewStore(env, postgres.DefaultConfig())

	scope, scopeID := "user_pii", "user-123"

	// 3. Create a DEK for this scope (inserts and returns version 1)
	key, err := store.CreateKey(ctx, pool, scope, scopeID)
	if err != nil {
		log.Fatalf("failed to create key: %v", err)
	}
	log.Printf("created DEK version %d under KEK %s", key.KeyVersion, key.KEKID)

	// 4. Encrypt and decrypt a single string value with optional payload AAD
	payloadAAD := []byte("field:email")
	ciphertext, err := env.EncryptString(ctx, key, "alice@example.com", payloadAAD)
	if err != nil {
		log.Fatalf("encryption failed: %v", err)
	}

	plaintext, err := env.DecryptString(ctx, key, ciphertext, payloadAAD)
	if err != nil {
		log.Fatalf("decryption failed: %v", err)
	}
	log.Printf("decrypted: %s", plaintext)
}
```

### Reusable sessions (`envelope.Session`)

When encrypting or decrypting multiple fields or events belonging to the same `(scope, scopeID)`, open an `envelope.Session` with `env.OpenSession(ctx, key)`. A session unwraps the DEK from the keyring once, holds the plaintext DEK in memory for fast local AES-256-GCM calls, and zeroes the DEK when `Close()` is called:

```go
sess, err := env.OpenSession(ctx, key)
if err != nil {
	return err
}
defer sess.Close()

emailCiphertext, err := sess.EncryptString("alice@example.com", nil)
if err != nil {
	return err
}

phoneCiphertext, err := sess.EncryptString("+1-555-0100", nil)
if err != nil {
	return err
}
```

Sessions also expose bytes-first `sess.Encrypt(plaintext, aad []byte)` and `sess.Decrypt(ciphertext, aad []byte)` methods when working with raw binary or JSON payloads directly.

## Transaction participation

In event-sourced applications, creating a DEK and appending the resulting event should happen inside the same database transaction.

`postgres.Store` is stateless and does not hold an internal connection pool. All store methods accept any executor satisfying the standard `pgx` query interface (`*pgxpool.Pool`, `pgx.Tx`, or `*pgx.Conn`), allowing you to pass an active transaction directly:

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
	EmailCiphertext string `json:"email_ciphertext"`
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

	// 1. Resolve or create the user's DEK inside the transaction
	key, err := keyStore.GetActiveKey(ctx, tx, scope, userID)
	if errors.Is(err, encryption.ErrKeyNotFound) {
		key, err = keyStore.CreateKey(ctx, tx, scope, userID)
	}
	if err != nil {
		return fmt.Errorf("resolve active key: %w", err)
	}

	// 2. Encrypt payload using the scoped DEK
	emailCiphertext, err := env.EncryptString(ctx, key, email, nil)
	if err != nil {
		return fmt.Errorf("encrypt email: %w", err)
	}

	payload, err := json.Marshal(UserRegisteredPayload{EmailCiphertext: emailCiphertext})
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	// 3. Append the event to eventsalsa/store in the same transaction
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

If the transaction rolls back at any point, both the DEK row and the appended event are discarded together.

## Domain modeling with encrypted values

To preserve clean architectural boundaries, keep domain models independent of infrastructure encryption packages. Aggregates should receive already-encrypted values or emit events containing domain value types.

### Define domain value types

Define explicit types for encrypted fields inside your domain package:

```go
package user

type EncryptedEmail string
type EncryptedFullName string

type UserRegistered struct {
	UserID             string
	EmailCiphertext    EncryptedEmail
	FullNameCiphertext EncryptedFullName
	EmailBidx          string
}

type UserDeleted struct {
	UserID string
}

type User struct {
	id          string
	uncommitted []any
}

func Register(userID string, emailCiphertext EncryptedEmail, fullNameCiphertext EncryptedFullName, emailBidx string) *User {
	u := &User{id: userID}
	u.uncommitted = append(u.uncommitted, UserRegistered{
		UserID:             userID,
		EmailCiphertext:    emailCiphertext,
		FullNameCiphertext: fullNameCiphertext,
		EmailBidx:          emailBidx,
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

The application service coordinates DEK creation, session-based encryption, blind-index hashing, aggregate construction, and event persistence:

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

	// 1. Create the user's DEK in PostgreSQL
	key, err := s.store.CreateKey(ctx, tx, scope, userID)
	if err != nil {
		return fmt.Errorf("create user dek: %w", err)
	}

	// 2. Open an encryption session to unwrap the DEK once for multiple fields
	sess, err := s.env.OpenSession(ctx, key)
	if err != nil {
		return fmt.Errorf("open encryption session: %w", err)
	}
	defer sess.Close()

	emailCiphertext, err := sess.EncryptString(email, nil)
	if err != nil {
		return fmt.Errorf("encrypt email: %w", err)
	}

	nameCiphertext, err := sess.EncryptString(name, nil)
	if err != nil {
		return fmt.Errorf("encrypt name: %w", err)
	}

	// 3. Compute deterministic blind index for lookups
	emailBidx := s.hasher.Hash(email)

	// 4. Instantiate domain aggregate with encrypted value objects
	aggregate := user.Register(
		userID,
		user.EncryptedEmail(emailCiphertext),
		user.EncryptedFullName(nameCiphertext),
		emailBidx,
	)

	// 5. Persist aggregate uncommitted events to eventsalsa/store
	return s.users.Save(ctx, tx, aggregate)
}
```

### Persist domain events with `eventsalsa/store`

The repository adapter serializes uncommitted domain events into `store.Event` records and appends them to `eventsalsa/store` inside the active transaction:

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

:::caution
Avoid projecting decrypted plaintext into read model tables unless strictly necessary. Persisting cleartext PII or secrets in read models bypasses encryption at rest in database snapshots, replicas, and ad-hoc queries, and means deleting a DEK (`DestroyKeys`) no longer erases the data on its own.

Instead, follow two rules when designing read models for sensitive data:
1. **For retrieval**: Store the **ciphertext** and **`key_version`** in the read model table during projection, and decrypt in memory on the read path after querying the row.
2. **For filtering and lookups**: Store a **keyed HMAC blind index** (`hash.HMACHasher`, which computes a two-pass keyed HMAC-SHA256 digest using a dedicated secret key) and **always prefer exact-match lookups** (`WHERE email_bidx = $1`) over substring, prefix, or full-text term search. Partial or token-based search indexes leak character-distribution and frequency patterns across sensitive values.
:::

### Projecting ciphertext, key version, and blind indexes

Store the encrypted fields alongside their `key_version` and exact-match blind index (`email_bidx`) in the read model table:

```sql
CREATE TABLE read_model.user_directory_v1 (
    user_id TEXT PRIMARY KEY,
    email_ciphertext TEXT NOT NULL,
    full_name_ciphertext TEXT NOT NULL,
    key_version INT NOT NULL,
    email_bidx TEXT NOT NULL UNIQUE,
    last_global_position BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_user_directory_v1_email_bidx
    ON read_model.user_directory_v1 (email_bidx);
```

During projection, persist the ciphertext and `key_version` directly without decrypting, and decrypt on the read path only when serving a query:

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
	"github.com/jackc/pgx/v5/pgxpool"
)

type UserRegisteredPayload struct {
	UserID             string `json:"user_id"`
	EmailCiphertext    string `json:"email_ciphertext"`
	FullNameCiphertext string `json:"full_name_ciphertext"`
	KeyVersion         int    `json:"key_version"`
	EmailBidx          string `json:"email_bidx"`
}

type UserView struct {
	UserID   string
	Email    string
	FullName string
}

type UserDirectoryProjection struct{}

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

		_, err := tx.Exec(ctx, `
			INSERT INTO read_model.user_directory_v1 (
				user_id, email_ciphertext, full_name_ciphertext, key_version, email_bidx, last_global_position
			)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (user_id) DO UPDATE
			SET email_ciphertext = EXCLUDED.email_ciphertext,
			    full_name_ciphertext = EXCLUDED.full_name_ciphertext,
			    key_version = EXCLUDED.key_version,
			    email_bidx = EXCLUDED.email_bidx,
			    last_global_position = EXCLUDED.last_global_position
			WHERE read_model.user_directory_v1.last_global_position < EXCLUDED.last_global_position
		`, payload.UserID, payload.EmailCiphertext, payload.FullNameCiphertext, payload.KeyVersion, payload.EmailBidx, event.GlobalPosition)
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

// FindUserByEmailBidx queries by exact-match blind index and decrypts after read.
func FindUserByEmailBidx(
	ctx context.Context,
	pool *pgxpool.Pool,
	keyStore *postgres.Store,
	env *envelope.Envelope,
	emailBidx string,
) (*UserView, error) {
	var (
		userID             string
		emailCiphertext    string
		fullNameCiphertext string
		keyVersion         int
	)
	err := pool.QueryRow(ctx, `
		SELECT user_id, email_ciphertext, full_name_ciphertext, key_version
		FROM read_model.user_directory_v1
		WHERE email_bidx = $1
	`, emailBidx).Scan(&userID, &emailCiphertext, &fullNameCiphertext, &keyVersion)
	if err != nil {
		return nil, fmt.Errorf("query user by blind index: %w", err)
	}

	key, err := keyStore.GetKey(ctx, pool, "user_pii", userID, keyVersion)
	if err != nil {
		return nil, fmt.Errorf("fetch dek v%d: %w", keyVersion, err)
	}

	sess, err := env.OpenSession(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("open session: %w", err)
	}
	defer sess.Close()

	email, err := sess.DecryptString(emailCiphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt email: %w", err)
	}
	fullName, err := sess.DecryptString(fullNameCiphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt full name: %w", err)
	}

	return &UserView{
		UserID:   userID,
		Email:    email,
		FullName: fullName,
	}, nil
}
```

This projection can run synchronously inside the append transaction or asynchronously via `eventsalsa/projector`.

## GDPR crypto-shredding (Right to Erasure)

Under privacy regulations such as GDPR (Article 17 — Right to Erasure), users have the right to request deletion of their personal data. In an append-only event store, deleting or updating past events violates immutability and invalidates stream integrity.

Crypto-shredding solves this problem:

1. Each subject is assigned a dedicated DEK (for example, `scope="user_pii", scopeID=userID`).
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
- If you use `kek.CachingKeyring`, call `cachedKeyring.Invalidate()` so any cached copy of the DEK is scrubbed immediately.
- Any subsequent attempt to call `store.GetActiveKey` or `store.GetKey` returns `encryption.ErrKeyNotFound`.
- Full stream replays encountering past PII payloads cannot decrypt them, ensuring personal data is unrecoverable.

:::caution
Revocation (`store.RevokeKeys`) is insufficient for GDPR compliance because revoked keys remain stored in the database for historical audit decryption. Complete erasure requires `store.DestroyKeys`.
:::

## Secret rotation and historical retention

Unlike user PII (which is pinned to one DEK and crypto-shredded upon deletion), operational secrets (such as API keys, OAuth tokens, and webhook secrets) require periodic rotation (e.g., every 90 days) while retaining the ability to decrypt historical audit trails.

### The rotation workflow

1. Create version 1 of the secret's DEK: `store.CreateKey(ctx, pool, "api_token", "stripe")`.
2. Encrypt payloads under version 1.
3. When rotating credentials, call `store.RotateKey(ctx, pool, "api_token", "stripe")`:
   - Generates a new random DEK bound to `KeyVersion: 2`.
   - Atomically soft-revokes version 1 (`revoked_at = NOW()`) and inserts version 2 in a single SQL statement.
   - Returns the newly created `*encryption.EncryptedKey` for version 2.
4. New writes automatically use version 2.
5. Historical records encrypted under version 1 remain decryptable by fetching version 1 explicitly with `store.GetKey(ctx, pool, "api_token", "stripe", 1)`.

```go
package app

import (
	"context"
	"log"

	"github.com/eventsalsa/encryption/envelope"
	"github.com/eventsalsa/encryption/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

func RotateSecretExample(ctx context.Context, pool *pgxpool.Pool, env *envelope.Envelope, store *postgres.Store) error {
	scope, secretID := "api_token", "stripe_production"

	// 1. Initial creation (Version 1)
	keyV1, err := store.CreateKey(ctx, pool, scope, secretID)
	if err != nil {
		return err
	}
	cipherV1, err := env.EncryptString(ctx, keyV1, "sk_live_v1_initial_secret", nil)
	if err != nil {
		return err
	}
	log.Printf("created version %d, encrypted payload: %s", keyV1.KeyVersion, cipherV1)

	// 2. Rotate to Version 2 (atomically revokes v1 and inserts v2)
	keyV2, err := store.RotateKey(ctx, pool, scope, secretID)
	if err != nil {
		return err
	}
	cipherV2, err := env.EncryptString(ctx, keyV2, "sk_live_v2_rotated_secret", nil)
	if err != nil {
		return err
	}
	log.Printf("rotated to version %d, encrypted payload: %s", keyV2.KeyVersion, cipherV2)

	// 3. Historical audit read: decrypt v1 using explicit version lookup
	histKeyV1, err := store.GetKey(ctx, pool, scope, secretID, 1)
	if err != nil {
		return err
	}
	decryptedV1, err := env.DecryptString(ctx, histKeyV1, cipherV1, nil)
	if err != nil {
		return err
	}
	log.Printf("historical v1 decrypted: %s (revoked at: %v)", decryptedV1, histKeyV1.RevokedAt)

	// 4. Active read: decrypt v2 using active key
	decryptedV2, err := env.DecryptString(ctx, keyV2, cipherV2, nil)
	if err != nil {
		return err
	}
	log.Printf("active v2 decrypted: %s", decryptedV2)

	return nil
}
```

## KEK rotation and rewrapping (`postgres.RewrapKeys`)

When rotating master KEKs—or migrating from local KEKs to AWS KMS or Google Cloud KMS—new DEKs are wrapped with the keyring's active KEK, while existing DEKs stored under the old KEK ID are re-encrypted in batches using `postgres.RewrapKeys`.

`postgres.RewrapKeys` re-wraps stored DEKs in place without rotating DEKs or re-encrypting application payloads.

### Recommended rewrap sequence

1. **Configure the keyring with both KEKs**: Register both the old KEK wrapper and the new KEK wrapper in `kek.Keyring`, setting the new KEK ID as active:
   ```go
   keyring, err := kek.NewKeyring(newKeyARN, oldWrapper, newAWSWrapper)
   if err != nil {
   	log.Fatalf("create keyring: %v", err)
   }
   env := envelope.New(keyring, aesgcm.New())
   ```
2. **Execute a dry run**: Preview how many stored DEK rows match the old KEK ID:
   ```go
   preview, err := postgres.RewrapKeys(ctx, pool, postgres.DefaultConfig(), env, postgres.RewrapKeysOptions{
   	FromKEKID: "kek-2025-01",
   	ToKEKID:   newKeyARN,
   	BatchSize: 500,
   	DryRun:    true,
   })
   if err != nil {
   	log.Fatalf("dry run failed: %v", err)
   }
   log.Printf("matched rows to rewrap: %d", preview.MatchedRows)
   ```
3. **Execute the batch rewrap**: Run `postgres.RewrapKeys` to migrate all matching rows:
   ```go
   result, err := postgres.RewrapKeys(ctx, pool, postgres.DefaultConfig(), env, postgres.RewrapKeysOptions{
   	FromKEKID: "kek-2025-01",
   	ToKEKID:   newKeyARN,
   	BatchSize: 500,
   })
   if err != nil {
   	log.Fatalf("rewrap failed: %v", err)
   }
   log.Printf("rewrapped=%d skipped=%d remaining=%d batches=%d",
   	result.RewrappedRows, result.SkippedRows, result.RemainingRows, result.Batches)
   ```
4. **Decommission the old KEK**: Once `RemainingRows` is `0`, remove the old KEK wrapper from your keyring configuration.

### How rewrap operates

- Runs in short, PostgreSQL-managed batch transactions using `FOR UPDATE SKIP LOCKED`, making concurrent rewrap workers safe.
- Verifies and preserves each row's canonical `KeyScope.AAD()` (`scope`, `scope_id`, `key_version`) during unwrap and wrap; if a row's ciphertext was tampered with or transplanted, the batch fails with `encryption.ErrDecryption` and rolls back.
- Uses native server-side re-encryption (`kms:ReEncrypt`) automatically when both source and target wrappers are `*awskms.Wrapper` instances sharing a client, and falls back to `Unwrap` + `Wrap` (with immediate memory scrubbing) when migrating across different providers.
- Covers both active and soft-revoked DEK rows without modifying `key_version` or touching application ciphertexts.

## Deterministic blind indexing (HMAC hashing)

Because AES-256-GCM uses random nonces for every encryption call, encrypting the same plaintext twice produces different ciphertexts. This prevents direct SQL equality queries (`WHERE email = $1`) and unique constraints on encrypted columns.

`hash.HMACHasher` provides deterministic blind indexing using HMAC-SHA256:

```go
package main

import (
	"fmt"

	"github.com/eventsalsa/encryption/hash"
)

func main() {
	// Secret key dedicated to HMAC blind indexing (separate from KEKs)
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

Use deterministic blind indexes for:
- Enforcing uniqueness constraints in database tables (e.g., `email_bidx TEXT UNIQUE`).
- Locating records by sensitive identifiers without storing plaintext.
- Generating deterministic stream IDs from sensitive keys.

:::note
Keep the HMAC secret key separate from KEKs. The HMAC key must remain stable for queries to resolve accurately across restarts.
:::

## Pluggable ciphers, AAD binding, and memory hygiene

### Pluggable symmetric AEAD cipher

`eventsalsa/encryption` defaults to AES-256-GCM (`cipher/aesgcm`), but you can supply any authenticated symmetric algorithm by implementing `cipher.Cipher`:

```go
package cipher

type Cipher interface {
	Encrypt(key, plaintext, aad []byte) ([]byte, error)
	Decrypt(key, ciphertext, aad []byte) ([]byte, error)
	KeySize() int
}
```

Pass your custom cipher into `envelope.New(keyring, customCipher)`.

### Scope AAD and payload AAD

`eventsalsa/encryption` uses Additional Authenticated Data (AAD) at two levels:

1. **Automatic DEK Scope AAD**: Every DEK wrapped by `envelope.Envelope` is automatically bound to `encryption.KeyScope{Scope, ScopeID, KeyVersion}.AAD()`, serialized in a collision-free length-prefixed binary format.
2. **Optional Payload AAD**: Every `Encrypt`, `Decrypt`, `EncryptString`, and `DecryptString` method on `envelope.Envelope` and `envelope.Session` accepts an `aad []byte` parameter. You can pass contextual metadata (such as an event ID, stream ID, or field name) to bind a ciphertext to its exact location in your domain model, or pass `nil` when payload AAD is not needed.

### Memory hygiene

Plaintext DEKs should never linger in the Go heap longer than necessary:

- Single-shot calls (`env.Encrypt`, `env.Decrypt`, `env.EncryptString`, `env.DecryptString`) automatically scrub the unwrapped DEK via `encryption.ZeroBytes` before returning.
- When using `env.OpenSession(ctx, key)`, always `defer session.Close()` immediately to zero the session's DEK buffer.
- When working with raw DEKs via `env.UnwrapDEK` or `env.GenerateDEK`, always `defer encryption.ZeroBytes(dek)`.

### Sentinel errors

All packages return shared sentinel errors defined in root `github.com/eventsalsa/encryption`:

| Sentinel Error | Description |
| :--- | :--- |
| `encryption.ErrKeyNotFound` | The requested DEK or KEK was not found in the store or keyring. |
| `encryption.ErrKeyExists` | A key for the specified `(scope, scopeID)` already exists during `CreateKey`. |
| `encryption.ErrEncryption` | Symmetric encryption or KEK wrapping failed. |
| `encryption.ErrDecryption` | Decryption or AEAD authentication tag / AAD verification failed. |
| `encryption.ErrInvalidKeySize` | Provided key size does not match the cipher's requirement. |
| `encryption.ErrKeyRevoked` | The requested key version has been soft-revoked. |
| `encryption.ErrKeyDestroyed` | The key has been permanently destroyed. |
| `encryption.ErrSessionClosed` | An operation was attempted on a closed `envelope.Session`, `local.Wrapper`, or `kek.CachingKeyring`. |
| `encryption.ErrInvalidConfig` | Required configuration, scope identifiers, or arguments are invalid or empty. |
