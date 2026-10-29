-- =====================================================================
-- SALES REP & COMMISSION TRACKING
-- =====================================================================
-- Model:
--  * sales_reps            — one row per salesperson (per company)
--  * customers.sales_rep_id — each customer is assigned to a rep
--  * commission_rates      — company-wide % per product unit type (bottle,
--                            gallon, each, ...). Same rate for all reps.
--  * sales_attributions    — one row per completed delivery line, STAMPED with
--                            the rep who owned the customer at delivery time.
--                            This is the historical record commissions are
--                            calculated from. When a customer's rep changes,
--                            old rows keep their original rep; any row whose
--                            stamped rep != the customer's current rep surfaces
--                            in the manager "holding" review queue.
-- =====================================================================

-- ---- Sales reps -----------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_reps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code VARCHAR(30),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(30),
    status VARCHAR(20) DEFAULT 'active', -- active | inactive
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_reps_company ON sales_reps(company_id);

-- ---- Assign a rep to each customer ---------------------------------
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS sales_rep_id UUID REFERENCES sales_reps(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_customers_sales_rep ON customers(sales_rep_id);

-- ---- Company-wide commission rate per product unit type ------------
-- unit_type matches products.unit ('gallon', 'bottle', 'each', 'tank', ...).
-- rate_percent is a percentage of the line revenue (e.g. 6.00 = 6%).
CREATE TABLE IF NOT EXISTS commission_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    unit_type VARCHAR(50) NOT NULL,
    rate_percent DECIMAL(6,3) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (company_id, unit_type)
);
CREATE INDEX IF NOT EXISTS idx_commission_rates_company ON commission_rates(company_id);

-- ---- Per-line sales attribution (the commission ledger) ------------
-- One row per completed delivery line item, stamped with the rep at the time.
CREATE TABLE IF NOT EXISTS sales_attributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    delivery_item_id UUID REFERENCES delivery_items(id) ON DELETE CASCADE,
    stop_id UUID REFERENCES route_run_stops(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    -- Rep stamped at delivery time (the historical owner). NULL = unassigned.
    sales_rep_id UUID REFERENCES sales_reps(id) ON DELETE SET NULL,
    unit_type VARCHAR(50),                 -- copied from product at stamp time
    quantity DECIMAL(12,2) DEFAULT 0,
    revenue DECIMAL(12,2) DEFAULT 0,       -- line revenue this sale represents
    rate_percent DECIMAL(6,3) DEFAULT 0,   -- rate applied at stamp time
    commission_amount DECIMAL(12,2) DEFAULT 0,
    sale_date DATE NOT NULL,               -- from stop departed_at
    -- Holding/review workflow:
    --   settled  = counts toward the stamped rep normally
    --   holding  = stamped rep no longer matches customer's current rep;
    --              awaiting a manager decision
    --   resolved = a manager has acted on it (see resolution)
    review_status VARCHAR(20) DEFAULT 'settled', -- settled | holding | resolved
    resolution VARCHAR(30),                -- keep_original | reassign_current | void | split
    resolved_rep_id UUID REFERENCES sales_reps(id) ON DELETE SET NULL,
    resolved_by UUID,                      -- user id who resolved
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_attr_company ON sales_attributions(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_attr_rep ON sales_attributions(sales_rep_id);
CREATE INDEX IF NOT EXISTS idx_sales_attr_customer ON sales_attributions(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_attr_date ON sales_attributions(sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_attr_review ON sales_attributions(review_status);
-- Prevent double-stamping the same delivery line
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_attr_item ON sales_attributions(delivery_item_id);

-- ---- Seed sensible default commission rates for existing companies --
-- (0% by default; owners set real rates in the UI. This just ensures the
--  common unit types exist so the settings screen isn't empty.)
INSERT INTO commission_rates (company_id, unit_type, rate_percent)
SELECT c.id, u.unit_type, 0
FROM companies c
CROSS JOIN (VALUES ('gallon'), ('bottle'), ('tank'), ('each')) AS u(unit_type)
ON CONFLICT (company_id, unit_type) DO NOTHING;

-- ---- Row-Level Security for the new tables --------------------------
-- Matches the app's RLS model: rows are visible only when
-- current_company_id() matches. Safe no-op if RLS isn't enabled yet
-- (policies only take effect once the app sets app.current_company_id).
DO $$
DECLARE t text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_company_id') THEN
        FOREACH t IN ARRAY ARRAY['sales_reps','commission_rates','sales_attributions'] LOOP
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
            EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
            EXECUTE format($f$
                CREATE POLICY tenant_isolation ON %I
                USING (company_id = current_company_id())
                WITH CHECK (company_id = current_company_id())
            $f$, t);
        END LOOP;
    END IF;
END $$;

