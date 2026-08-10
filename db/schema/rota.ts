// Mirrors db/migrations/0002_rota.sql field-for-field. See the note at
// the top of db/schema/foundation.ts — the SQL migrations are the
// source of truth.
import {
  boolean,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants, users } from "@/db/schema/foundation";

export const rotaShiftDefinitions = pgTable(
  "rota_shift_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    sortOrder: smallint("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.key)],
);

export const rotaStaff = pgTable(
  "rota_staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id").references(() => users.id),
    name: text("name").notNull(),
    role: text("role").notNull(),
    contractHours: numeric("contract_hours", { precision: 5, scale: 2 }).notNull().default("37.5"),
    maxDays: smallint("max_days").notNull().default(5),
    officeHours: boolean("office_hours").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const rotaAvailability = pgTable(
  "rota_availability",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    staffId: uuid("staff_id").notNull().references(() => rotaStaff.id),
    dayOfWeek: smallint("day_of_week").notNull(),
    mode: text("mode").notNull().default("any"), // any | shifts | off
    shiftKeys: jsonb("shift_keys").notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.staffId, t.dayOfWeek)],
);

export const rotaDemand = pgTable(
  "rota_demand",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    dayOfWeek: smallint("day_of_week").notNull(),
    shiftKey: text("shift_key").notNull(), // shift definition key, or virtual key 'sleepover'
    headcount: smallint("headcount").notNull().default(0),
  },
  (t) => [unique().on(t.tenantId, t.dayOfWeek, t.shiftKey)],
);

export const rotaWeeks = pgTable(
  "rota_weeks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    weekStart: date("week_start").notNull(),
    onCallStaffId: uuid("on_call_staff_id").references(() => rotaStaff.id),
    built: boolean("built").notNull().default(false),
    builtAt: timestamp("built_at", { withTimezone: true }),
    unfilled: jsonb("unfilled").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.weekStart)],
);

export const rotaAssignments = pgTable(
  "rota_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    weekId: uuid("week_id").notNull().references(() => rotaWeeks.id),
    staffId: uuid("staff_id").notNull().references(() => rotaStaff.id),
    dayOfWeek: smallint("day_of_week").notNull(),
    kind: text("kind").notNull(), // shift | code
    shiftKey: text("shift_key"),
    sleepover: boolean("sleepover").notNull().default(false),
    code: text("code"),
    locked: boolean("locked").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.weekId, t.staffId, t.dayOfWeek),
    index("rota_assignments_week_idx").on(t.tenantId, t.weekId),
  ],
);
