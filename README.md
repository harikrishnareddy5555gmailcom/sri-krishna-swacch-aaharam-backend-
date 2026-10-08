# Sri Krishna Swacch Aaharam — Backend API & Database Service

Production-grade NestJS REST API and Prisma database architecture powering **Sri Krishna Swacch Aaharam** (cold pressed cooking oils & wholesome natural foods from Macherla).

---

## 🌾 Tech Stack

- **Framework**: NestJS 12 (TypeScript)
- **Database & ORM**: PostgreSQL + Prisma ORM 6
- **Authentication**: Passport.js + JWT (Access Token + Refresh Token flow)
- **Security**: Helmet, bcrypt, class-validator, Throttler rate limiting, CORS controls
- **Testing**: Vitest + Supertest (Unit, Integration, E2E)
- **Validation**: Zod & class-validator

---

## 📁 Repository Structure

```
├── apps/
│   └── api/                   # Main NestJS backend service
│       ├── prisma/            # Database schema, migrations, seed scripts
│       │   ├── schema.prisma  # Complete PostgreSQL schema
│       │   ├── migrations/    # Versioned database migration history
│       │   └── seed.ts        # Database seed runner
│       ├── src/
│       │   ├── auth/          # Authentication & JWT strategies
│       │   ├── catalog/       # Products, categories, cold pressed oils
│       │   ├── orders/        # Orders, idempotency, lifecycle management
│       │   ├── cart/          # Cart management & snapshots
│       │   ├── checkout/      # Checkout sessions & validations
│       │   ├── payment/       # Payment attempts, webhooks, refunds
│       │   ├── shipping/      # Pincodes, delivery estimates, tracking
│       │   ├── admin/         # CA Finance, expenses, audits, reports
│       │   ├── notifications/ # User notifications & system alerts
│       │   └── users/         # Users, roles, permission enforcement
│       └── test/              # Integration & E2E test suites
├── packages/
│   ├── config/                # Environment schema validation
│   ├── types/                 # Shared TypeScript models & contracts
│   └── shared/                # RBAC permission engine, validators, constants
├── package.json               # Root workspace scripts
├── pnpm-workspace.yaml        # Workspace configuration
└── tsconfig.json              # TypeScript root configuration
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: `>= 20.0.0`
- **pnpm**: `>= 9.0.0`
- **PostgreSQL**: `>= 15.0`

### 1. Installation

```bash
pnpm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Configure your PostgreSQL database connection:
```ini
DATABASE_URL="postgresql://postgres:your_password@localhost:5432/vishkaraa_db?schema=public"
JWT_SECRET=your_secure_random_key_at_least_32_characters
```

### 3. Database Migration & Seeding

```bash
# Run database migrations
pnpm db:migrate

# Seed categories, products, and default accounts
pnpm db:seed
```

### 4. Running the Development Server

```bash
pnpm dev
```

The API will be available at [http://localhost:3001/api/v1](http://localhost:3001/api/v1).
Interactive Swagger documentation is available at [http://localhost:3001/api/docs](http://localhost:3001/api/docs).

### 5. Running Tests

```bash
# Unit & integration tests
pnpm test

# E2E test suite
pnpm test:e2e
```

### 6. Production Build & Start

```bash
pnpm run build
pnpm run start:prod
```

---

## 📄 License

Private & Proprietary — © Sri Krishna Swacch Aaharam. All rights reserved.
