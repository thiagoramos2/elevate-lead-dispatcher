-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('new', 'contacted', 'no_answer', 'callback', 'qualified', 'sale', 'refund', 'invalid');

-- CreateEnum
CREATE TYPE "distribution_status" AS ENUM ('pending', 'distributed', 'failed');

-- CreateEnum
CREATE TYPE "lead_event_origin" AS ENUM ('system', 'webhook', 'operator');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('admin', 'operator');

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funnels" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "product_id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "funnels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "external_ref" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_centers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "weight" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "call_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatcher_state" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "cursor" BIGINT NOT NULL DEFAULT 0,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatcher_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "product_id" UUID NOT NULL,
    "funnel_id" UUID NOT NULL,
    "affiliate_id" UUID,
    "source" VARCHAR(64) NOT NULL,
    "campaign" VARCHAR(255),
    "utm_source" VARCHAR(255),
    "utm_medium" VARCHAR(255),
    "utm_campaign" VARCHAR(255),
    "utm_content" VARCHAR(255),
    "utm_term" VARCHAR(255),
    "status" "lead_status" NOT NULL DEFAULT 'new',
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "distribution_status" "distribution_status" NOT NULL DEFAULT 'pending',
    "call_center_id" UUID,
    "distributed_at" TIMESTAMPTZ(3),
    "idempotency_key" VARCHAR(300) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "lead_id" UUID NOT NULL,
    "call_center_id" UUID NOT NULL,
    "cursor" BIGINT NOT NULL,
    "config_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "lead_id" UUID NOT NULL,
    "origin" "lead_event_origin" NOT NULL,
    "call_center_id" UUID,
    "actor_user_id" UUID,
    "dedup_key" CHAR(64) NOT NULL,
    "external_id" VARCHAR(128),
    "from_status" "lead_status",
    "to_status" "lead_status" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied" BOOLEAN NOT NULL,
    "rejection_reason" VARCHAR(32),
    "payload" JSONB,

    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "call_center_id" UUID,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token_hash" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "funnels_product_id_slug_key" ON "funnels"("product_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "funnels_id_product_id_key" ON "funnels"("id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_external_ref_key" ON "affiliates"("external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "call_centers_slug_key" ON "call_centers"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "leads_idempotency_key_key" ON "leads"("idempotency_key");

-- CreateIndex
CREATE INDEX "leads_created_at_id_idx" ON "leads"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "leads_call_center_created_at_idx" ON "leads"("call_center_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "leads_status_created_at_idx" ON "leads"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_product_funnel_created_at_idx" ON "leads"("product_id", "funnel_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "distributions_lead_id_key" ON "distributions"("lead_id");

-- CreateIndex
CREATE INDEX "lead_events_lead_id_occurred_at_idx" ON "lead_events"("lead_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_events_lead_id_dedup_key_key" ON "lead_events"("lead_id", "dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- AddForeignKey
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_funnel_id_product_id_fkey" FOREIGN KEY ("funnel_id", "product_id") REFERENCES "funnels"("id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_call_center_id_fkey" FOREIGN KEY ("call_center_id") REFERENCES "call_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_call_center_id_fkey" FOREIGN KEY ("call_center_id") REFERENCES "call_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_call_center_id_fkey" FOREIGN KEY ("call_center_id") REFERENCES "call_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_call_center_id_fkey" FOREIGN KEY ("call_center_id") REFERENCES "call_centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: constraints and indexes that Prisma's schema language cannot express.
-- ---------------------------------------------------------------------------

-- Dispatcher weights must be positive; the schedule is built from them (ADR-0003).
ALTER TABLE "call_centers" ADD CONSTRAINT "call_centers_weight_positive" CHECK ("weight" > 0);

-- dispatcher_state is a single-row table. The row is structural (not demo data), so it is created here.
ALTER TABLE "dispatcher_state" ADD CONSTRAINT "dispatcher_state_single_row" CHECK ("id" = 1);
ALTER TABLE "dispatcher_state" ADD CONSTRAINT "dispatcher_state_cursor_non_negative" CHECK ("cursor" >= 0);
INSERT INTO "dispatcher_state" ("id") VALUES (1);

-- A lead is "distributed" exactly when it has a call center and a distribution time.
ALTER TABLE "leads" ADD CONSTRAINT "leads_distribution_consistent" CHECK (
  ("distribution_status" = 'distributed') = ("call_center_id" IS NOT NULL AND "distributed_at" IS NOT NULL)
);

-- An event is either applied, or rejected with a reason. Never both, never neither.
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_applied_xor_reason" CHECK (
  "applied" = ("rejection_reason" IS NULL)
);

-- Operators belong to exactly one call center; admins to none.
ALTER TABLE "users" ADD CONSTRAINT "users_role_call_center" CHECK (
  ("role" = 'operator') = ("call_center_id" IS NOT NULL)
);

-- "Pending" metric and stuck-lead reconciliation scan only undistributed leads.
-- Partial: in steady state almost every lead is distributed, so this index stays tiny.
CREATE INDEX "leads_undistributed_created_at_idx" ON "leads" ("created_at")
  WHERE "distribution_status" <> 'distributed';

-- The outbox relay polls only unpublished events, in insertion order.
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" ("id")
  WHERE "published_at" IS NULL;
