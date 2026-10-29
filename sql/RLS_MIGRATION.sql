-- =====================================================================
-- ROW-LEVEL SECURITY (RLS) MIGRATION  —  Tenant Isolation Safety Net
-- =====================================================================
-- Purpose: enforce company_id isolation at the DATABASE layer so that even
-- if application code ever forgets a `WHERE company_id = $1` filter, Postgres
-- will not return or modify another tenant's rows.
--
-- HOW IT WORKS
--   The app opens a transaction and runs:
--       SELECT set_config('app.current_company_id', '<company uuid>', true);
--   (this is what utils/db.js -> tenantQuery() does automatically).
--   Every policy below restricts rows to that company id.
--
-- IMPORTANT PREREQUISITE
--   RLS only takes effect for queries run through tenantQuery() (which sets
--   the variable inside the same transaction). Plain query() calls will have
--   an empty setting and, under these policies, will see NO rows for
--   RLS-protected tables. Migrate tenant reads/writes to tenantQuery() before
--   (or at the same time as) enabling this. See rollout notes at the bottom.
--
--   The table owner / superuser BYPASSES RLS by default. Neon's default role
--   is typically the table owner, so also FORCE RLS so the app role is subject
--   to it. If your app connects as a NON-owner role, FORCE is not required but
--   is harmless.
--
-- SAFETY
--   This migration is idempotent: policies are dropped-if-exists then created.
--   It does NOT drop or alter any data.
-- =====================================================================

-- Helper: read the current tenant from the session, NULL if unset/invalid.
CREATE OR REPLACE FUNCTION current_company_id() RETURNS uuid AS $$
DECLARE
    v text;
BEGIN
    v := current_setting('app.current_company_id', true); -- true = don't error if missing
    IF v IS NULL OR v = '' THEN
        RETURN NULL;
    END IF;
    RETURN v::uuid;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- Direct-tenant tables (have their own company_id column)
-- ---------------------------------------------------------------------
DO $$
DECLARE
    t text;
    direct_tables text[] := ARRAY[
        'distribution_centers',
        'trucks',
        'drivers',
        'customers',
        'orders',
        'products',
        'customer_products',
        'delivery_items',
        'routes',
        'route_runs',
        'route_templates',
        'truck_inventory',
        'truck_inventory_log',
        'audit_log',
        'users',
        'customer_transactions',
        'customer_consumption',
        'customer_predictions',
        'seasonal_factors',
        'dc_inventory',
        'invoices',
        'payments',
        'billing_ledger'
    ];
BEGIN
    FOREACH t IN ARRAY direct_tables LOOP
        -- Only touch tables that actually exist and have a company_id column
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = t AND column_name = 'company_id'
        ) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
            EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
            EXECUTE format($f$
                CREATE POLICY tenant_isolation ON %I
                USING (company_id = current_company_id())
                WITH CHECK (company_id = current_company_id())
            $f$, t);
            RAISE NOTICE 'RLS enabled on %', t;
        ELSE
            RAISE NOTICE 'Skipped % (missing or no company_id)', t;
        END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Child tables (no company_id of their own — isolate via their parent)
-- ---------------------------------------------------------------------

-- route_stops -> routes.company_id
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'route_stops') THEN
        ALTER TABLE route_stops ENABLE ROW LEVEL SECURITY;
        ALTER TABLE route_stops FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON route_stops;
        CREATE POLICY tenant_isolation ON route_stops
            USING (EXISTS (
                SELECT 1 FROM routes r
                WHERE r.id = route_stops.route_id
                  AND r.company_id = current_company_id()
            ))
            WITH CHECK (EXISTS (
                SELECT 1 FROM routes r
                WHERE r.id = route_stops.route_id
                  AND r.company_id = current_company_id()
            ));
    END IF;
END $$;

-- route_template_stops -> route_templates.company_id
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'route_template_stops') THEN
        ALTER TABLE route_template_stops ENABLE ROW LEVEL SECURITY;
        ALTER TABLE route_template_stops FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON route_template_stops;
        CREATE POLICY tenant_isolation ON route_template_stops
            USING (EXISTS (
                SELECT 1 FROM route_templates rt
                WHERE rt.id = route_template_stops.template_id
                  AND rt.company_id = current_company_id()
            ))
            WITH CHECK (EXISTS (
                SELECT 1 FROM route_templates rt
                WHERE rt.id = route_template_stops.template_id
                  AND rt.company_id = current_company_id()
            ));
    END IF;
END $$;

-- route_run_stops -> route_runs.company_id
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'route_run_stops') THEN
        ALTER TABLE route_run_stops ENABLE ROW LEVEL SECURITY;
        ALTER TABLE route_run_stops FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON route_run_stops;
        CREATE POLICY tenant_isolation ON route_run_stops
            USING (EXISTS (
                SELECT 1 FROM route_runs rr
                WHERE rr.id = route_run_stops.run_id
                  AND rr.company_id = current_company_id()
            ))
            WITH CHECK (EXISTS (
                SELECT 1 FROM route_runs rr
                WHERE rr.id = route_run_stops.run_id
                  AND rr.company_id = current_company_id()
            ));
    END IF;
END $$;

-- =====================================================================
-- ROLLOUT NOTES  (read before running in production)
-- =====================================================================
-- 1. This is a SAFETY NET, not a replacement for the existing
--    `WHERE company_id = $1` filters. Keep those — defense in depth.
--
-- 2. Before enabling in production, migrate tenant data access to
--    tenantQuery(companyId, ...). Any tenant read still using plain query()
--    will see zero rows on RLS-protected tables (the policy fails closed).
--    Super-admin/cross-tenant endpoints (billing.js, company management)
--    should connect as a role that bypasses RLS, OR you can add explicit
--    super-admin policies — see below.
--
-- 3. If you are not ready to switch to tenantQuery() everywhere yet, you can
--    stage this: run it on a COPY/branch database in Neon first and test that
--    normal tenant flows still work end-to-end.
--
-- 4. TO ROLL BACK (disable RLS) if something misbehaves:
--       ALTER TABLE customers DISABLE ROW LEVEL SECURITY;  -- repeat per table
--    (Policies remain defined but inactive while RLS is disabled.)
--
-- 5. OPTIONAL super-admin bypass policy (if your app role is NOT the owner):
--    For each table you could add a second policy allowing rows when the
--    session sets app.current_company_id to the sentinel '00000000-...'
--    for trusted super-admin operations. Left out here to avoid creating an
--    over-broad escape hatch by default.
-- =====================================================================
