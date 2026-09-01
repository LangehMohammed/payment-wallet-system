# Payment Wallet System

A backend payment wallet system built with **NestJS, TypeScript, PostgreSQL, and Prisma**, designed around financial transaction integrity, idempotent operations, ledger-based accounting, and reliable payment processing.

The project explores the engineering challenges involved in building a payment system where **correctness, consistency, security, and reliability** are more important than simply moving data between database tables.

## Overview

The system provides the backend infrastructure for managing user wallets and processing financial transactions including:

* Deposits
* Withdrawals
* Wallet-to-wallet transfers
* External payment-provider processing
* Transaction settlement
* Ledger-based wallet history

The architecture is designed to handle important payment-system concerns such as **concurrent transactions, duplicate requests, asynchronous provider processing, failed operations, and auditable financial records**.

---

## Engineering Highlights

### Financial Transaction Integrity

Financial operations are executed using database transactions to ensure related changes succeed or fail atomically.

Wallet operations account for concurrent requests by locking wallet records during critical balance modifications.

Transfers additionally acquire wallet locks in a consistent order to reduce the risk of database deadlocks when multiple transfers operate on the same wallets concurrently.

### Idempotent Financial Operations

Financial APIs use idempotency keys to prevent duplicate operations when clients retry requests.

For example, if a client sends a transfer request and experiences a network timeout, it can safely retry the request using the same idempotency key.

Instead of creating another transaction, the system recognizes the previous operation and returns the existing transaction.

This protects against duplicate financial operations caused by:

* Network failures
* Request timeouts
* Client retries
* Duplicate submissions

### Ledger-Based Accounting

Wallet balances are accompanied by persistent ledger entries that provide an auditable history of financial movements.

Ledger entries record:

* Wallet
* Transaction
* Debit/credit direction
* Amount
* Currency
* Balance after the entry
* Creation timestamp

This separates the concept of the **current wallet balance** from the historical record of how that balance was produced.

### Pending and Locked Funds

The wallet maintains separate balances for different states of funds:

```text
availableBalance
pendingBalance
lockedBalance
```

This allows the system to represent funds that are:

* Immediately available
* Awaiting settlement
* Temporarily locked during withdrawal processing

For example, a withdrawal can move funds from the available balance into locked funds while an external payment provider processes the operation.

Similarly, deposits can initially be represented as pending before settlement makes the funds available.

### Reliable Asynchronous Processing

The payment-processing architecture uses an **outbox-based workflow** to support reliable asynchronous processing.

Financial operations can create outbox events as part of the same database transaction. These events can then be processed independently by background workers.

The processing pipeline supports:

* Event delivery
* Retry handling
* Provider-specific processing
* Settlement workflows
* Asynchronous webhook-based completion
* Distributed processing locks

This reduces the risk of losing an event after a successful database transaction.

### Payment Provider Abstraction

External payment providers are isolated behind a common provider interface and registry.

This allows the core payment-processing workflow to remain independent from provider-specific implementation details.

Current provider integrations include:

* Stripe
* PayPal

The architecture makes it possible to add additional providers without coupling the core transaction workflow to a specific provider implementation.

### Secure Authentication

Authentication uses:

* JWT access tokens
* Refresh tokens
* Argon2id password hashing
* Refresh-token rotation
* Refresh-token revocation
* Refresh-token reuse detection
* Access-token invalidation
* Session management
* Audit logging

Refresh tokens are stored as hashes rather than persisted as raw tokens.

The authentication flow also includes protections designed to reduce information leakage from differences in authentication processing.

### Cursor-Based Ledger Pagination

Wallet ledger history uses cursor-based pagination rather than relying exclusively on offset pagination.

The cursor is based on ledger ordering information, allowing wallet histories to remain efficient as the number of ledger entries grows.

---

## Architecture

The application follows a modular NestJS architecture with separation between HTTP handling, business logic, persistence, infrastructure, and external payment providers.

```text
src/
├── common/
│   ├── audit/
│   ├── context/
│   ├── decorators/
│   ├── filters/
│   ├── guards/
│   └── interceptors/
│
├── config/
│
├── modules/
│   ├── auth/
│   ├── crypto/
│   ├── health/
│   ├── payment/
│   │   └── providers/
│   ├── redis/
│   ├── stripe-connect/
│   ├── transaction/
│   ├── user/
│   └── wallet/
│
└── prisma/
```

### Application flow

```text
HTTP Request
     │
     ▼
 Controller
     │
     ▼
 Service
     │
     ├──────────────► Payment Provider
     │
     ▼
 Repository
     │
     ▼
 Prisma
     │
     ▼
 PostgreSQL
```

For asynchronous payment processing:

```text
Transaction
     │
     ▼
Database Transaction
     │
     ├── Wallet Changes
     ├── Transaction Record
     ├── Ledger Entries
     └── Outbox Event
              │
              ▼
       Background Processor
              │
              ▼
       Payment Provider
              │
              ▼
          Settlement
```

---

## Core Transaction Flows

### Transfer

A wallet-to-wallet transfer follows a flow similar to:

```text
Client Request
      │
      ▼
Validate Idempotency Key
      │
      ▼
Resolve Sender & Receiver Wallets
      │
      ▼
Acquire Wallet Locks
      │
      ▼
Validate Wallet State
      │
      ▼
Validate Currency & Balance
      │
      ▼
Debit Sender
      │
      ▼
Credit Receiver
      │
      ├── Create Transaction
      ├── Create Ledger Entries
      └── Create Outbox Event
      │
      ▼
Commit
```

The balance changes and associated records are committed atomically.

### Deposit

```text
Deposit Request
      │
      ▼
Create Transaction
      │
      ▼
Credit Pending Balance
      │
      ▼
Create Ledger / Outbox Records
      │
      ▼
External Provider Processing
      │
      ▼
Settlement
      │
      ▼
Move Funds to Available Balance
```

### Withdrawal

```text
Withdrawal Request
      │
      ▼
Validate Available Balance
      │
      ▼
Move Funds to Locked Balance
      │
      ▼
Create Transaction / Ledger / Outbox
      │
      ▼
External Provider Processing
      │
      ├── Success ──► Settlement
      │
      └── Failure ──► Failure Handling
```

---

## Data Model

The core financial model is centered around users, wallets, transactions, ledger entries, payment logs, and outbox events.

```text
User
 │
 └── Wallet
      │
      ├── LedgerEntry
      │
      └── Transaction
             │
             ├── LedgerEntry
             ├── PaymentLog
             └── OutboxEvent
```

### Wallet

A wallet maintains the current financial state of a user.

Important balance concepts include:

* Available balance
* Pending balance
* Locked balance
* Currency
* Wallet status

### Transaction

Transactions represent business-level financial operations.

Supported transaction types include:

* Deposit
* Withdrawal
* Transfer

Transactions also maintain a lifecycle that distinguishes processing from successful settlement.

### Ledger Entry

Ledger entries represent individual financial movements associated with transactions.

They provide a persistent history that can be used to reconstruct and audit wallet activity.

### Outbox Event

Outbox events represent asynchronous work that must be processed after a successful financial operation.

Events track processing state and retry information so failed processing can be retried.

---

## Security

Security is treated as a core part of the system rather than an additional layer.

### Authentication

* JWT authentication
* Access and refresh tokens
* Refresh-token rotation
* Session revocation
* Token reuse detection
* Argon2id password hashing

### API Security

* Request validation
* Rate limiting
* Helmet security headers
* Authentication guards
* Environment-based configuration

### Financial Security

* Idempotency protection
* Database transactions
* Wallet locking
* Balance validation
* Currency validation
* Immutable transaction history
* Provider transaction references

---

## Technology Stack

| Category                    | Technology        |
| --------------------------- | ----------------- |
| Language                    | TypeScript        |
| Runtime                     | Node.js           |
| Framework                   | NestJS            |
| ORM                         | Prisma            |
| Database                    | PostgreSQL        |
| Cache / Distributed Locking | Redis             |
| Authentication              | JWT / Passport    |
| Password Hashing            | Argon2            |
| Payments                    | Stripe / PayPal   |
| API Documentation           | Swagger / OpenAPI |
| Testing                     | Jest / Supertest  |
| Containerization            | Docker            |

---

## Getting Started

### Prerequisites

Install the following before running the project:

* Node.js
* npm
* Docker
* Docker Compose

### Clone the repository

```bash
git clone https://github.com/LangehMohammed/payment-wallet-system.git

cd payment-wallet-system
```

### Install dependencies

```bash
npm install
```

### Configure environment variables

Create a `.env` file in the project root.

Example:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5434/nest?schema=public

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_token_secret

STRIPE_SECRET_KEY=your_stripe_secret_key
```

Add any additional environment variables required by the application's current configuration.

### Start infrastructure

Start PostgreSQL and Redis using Docker Compose:

```bash
docker compose up -d
```

### Run database migrations

```bash
npx prisma migrate dev
```

### Start the application

Development:

```bash
npm run start:dev
```

Production:

```bash
npm run build
npm run start:prod
```

The API is available at:

```text
http://localhost:3000
```

---

## Docker

The project includes Docker configuration for running the application and supporting infrastructure.

Build and start the services with:

```bash
docker compose up --build
```

For production-style deployment, Prisma migrations are applied before the application starts.

---

## API Documentation

The API is documented using **Swagger / OpenAPI**.

After starting the application, open:

```text
http://localhost:3000/api
```

The Swagger interface provides an interactive view of the available API endpoints, request schemas, and responses.

---

## Testing

Run unit tests:

```bash
npm run test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Run end-to-end tests:

```bash
npm run test:e2e
```

Generate test coverage:

```bash
npm run test:cov
```

---

## Engineering Decisions

### Why use a ledger?

A mutable wallet balance alone does not provide an adequate financial audit trail.

The system therefore records individual financial movements as ledger entries while maintaining wallet balances for efficient access to the current state.

### Why use idempotency keys?

Payment requests can be retried because of network failures or client timeouts.

Without idempotency, a retry could create a second financial operation.

Idempotency keys allow the system to treat repeated requests as the same logical operation.

### Why lock wallets?

Two concurrent transactions can otherwise read the same balance before either transaction writes its update.

Locking the relevant wallet rows during critical financial operations helps serialize conflicting balance modifications.

### Why consistent lock ordering?

A transfer involves two wallets.

If one transaction locks wallet A and then wallet B while another locks wallet B and then wallet A, the two transactions can potentially wait for each other.

Acquiring locks in a consistent order reduces this deadlock scenario.

### Why use an outbox?

A financial transaction and the asynchronous event generated by that transaction need to remain consistent.

Persisting the outbox event within the same database transaction means the event is committed together with the financial operation and can be processed afterward.

### Why abstract payment providers?

Payment-provider APIs have different authentication, request, response, and settlement models.

A provider interface allows the core payment-processing workflow to operate against a consistent abstraction while keeping provider-specific logic isolated.

---

## Project Goals

The project is being developed with a focus on:

* **Correctness** — financial operations must produce consistent results.
* **Atomicity** — related database changes should commit together.
* **Idempotency** — retries should not create duplicate financial operations.
* **Auditability** — financial movements should have a persistent history.
* **Concurrency safety** — simultaneous transactions should not corrupt balances.
* **Security** — authentication and financial operations require defensive controls.
* **Reliability** — asynchronous payment processing should tolerate failures and retries.
* **Scalability** — database access, background processing, and ledger queries should remain practical as data grows.
* **Maintainability** — business logic and infrastructure concerns should remain separated.

---

## Project Status

This project is under active development.

The primary objective is to build a realistic backend payment system while exploring the architectural and engineering challenges involved in financial software.

The implementation will continue to evolve as additional reliability, testing, observability, reconciliation, and payment-processing capabilities are developed.

---

## Future Improvements

Potential areas for further development include:

* Expanded integration and end-to-end test coverage
* Payment reconciliation workflows
* Improved transaction monitoring and observability
* Stronger failure-recovery mechanisms
* More comprehensive provider webhook handling
* Performance and concurrency testing
* Additional financial reporting capabilities
* Production deployment hardening

---

## Author

**Langeh Mohammed**

Backend Developer focused on building scalable, reliable, and maintainable backend systems with TypeScript and NestJS.
