// Mirrors db/migrations/0001_foundation.sql field-for-field.
// This is a query-builder schema, not the source of truth — the SQL
// migrations are. Table/trigger/RLS behaviour lives only in the .sql files;
// keep this file in sync by hand when a migration changes shape.
import {
  boolean,
  date,
  index,
  inet,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  regulator: text("regulator").notNull().default("care_inspectorate"),
  timezone: text("timezone").notNull().default("Europe/London"),
  retentionYears: smallint("retention_years").notNull().default(10),
  settings: jsonb("settings").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const units = pgTable(
  "units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.name)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    email: text("email"), // citext in the DB
    displayName: text("display_name").notNull(),
    jobTitle: text("job_title"),
    passwordHash: text("password_hash"),
    pinHash: text("pin_hash"),
    role: text("role").notNull(), // carer | senior | manager | admin
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.email)],
);

export const userUnits = pgTable(
  "user_units",
  {
    userId: uuid("user_id").notNull().references(() => users.id),
    unitId: uuid("unit_id").notNull().references(() => units.id),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  },
  (t) => [unique().on(t.userId, t.unitId)],
);

export const residents = pgTable(
  "residents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    unitId: uuid("unit_id").references(() => units.id),
    reference: text("reference"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    preferredName: text("preferred_name"),
    dateOfBirth: date("date_of_birth").notNull(),
    room: text("room"),
    status: text("status").notNull().default("active"), // active | discharged | deceased
    admittedOn: date("admitted_on").notNull(),
    departedOn: date("departed_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.reference)],
);

export const recordTypes = pgTable(
  "record_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    category: text("category"),
    sortOrder: smallint("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.key)],
);

export const recordTypeVersions = pgTable(
  "record_type_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    recordTypeId: uuid("record_type_id").notNull().references(() => recordTypes.id),
    version: smallint("version").notNull(),
    formSchema: jsonb("form_schema").notNull(),
    uiSchema: jsonb("ui_schema").notNull().default({}),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.recordTypeId, t.version)],
);

export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    residentId: uuid("resident_id").notNull().references(() => residents.id),
    recordTypeId: uuid("record_type_id").notNull().references(() => recordTypes.id),
    schemaVersionId: uuid("schema_version_id").notNull().references(() => recordTypeVersions.id),
    data: jsonb("data").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedBy: uuid("recorded_by").notNull().references(() => users.id),
    recordedByName: text("recorded_by_name").notNull(),
    unitId: uuid("unit_id").references(() => units.id),
    supersedesId: uuid("supersedes_id"),
    supersededById: uuid("superseded_by_id"),
    correctionReason: text("correction_reason"),
    clientUuid: uuid("client_uuid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.tenantId, t.clientUuid),
    index("entries_resident_time_idx").on(t.tenantId, t.residentId, t.occurredAt),
    index("entries_unit_time_idx").on(t.tenantId, t.unitId, t.occurredAt),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(), // bigserial in SQL; uuid-shaped read here is fine, PK type not relied on by app code
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    actorId: uuid("actor_id").references(() => users.id),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    residentId: uuid("resident_id").references(() => residents.id),
    detail: jsonb("detail").notNull().default({}),
    ipAddress: inet("ip_address"),
    deviceLabel: text("device_label"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_tenant_time_idx").on(t.tenantId, t.occurredAt)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    deviceLabel: text("device_label"),
    isSharedDevice: boolean("is_shared_device").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
