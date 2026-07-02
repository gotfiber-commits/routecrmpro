-- =====================================================
-- PENDING MIGRATIONS - Run this in Neon SQL Editor
-- =====================================================
-- This file contains all migrations that need to be run 
-- after FULL_MIGRATION.sql
-- 
-- Safe to re-run (uses IF NOT EXISTS throughout)
-- Last updated: 2026-03-09
-- =====================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. SITE SETTINGS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS site_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 2. BILLING SYSTEM TABLES
-- =====================================================

-- Invoices table
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    plan VARCHAR(50) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    tax DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    due_date DATE NOT NULL,
    paid_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(50),
    transaction_id VARCHAR(255),
    status VARCHAR(20) DEFAULT 'completed',
    description TEXT,
    processed_by UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Billing ledger for complete account history
CREATE TABLE IF NOT EXISTS billing_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    balance DECIMAL(10,2) NOT NULL,
    description TEXT NOT NULL,
    reference_type VARCHAR(20),
    reference_id UUID,
    created_by_type VARCHAR(20),
    created_by_id UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Plan pricing table
CREATE TABLE IF NOT EXISTS plan_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    monthly_price DECIMAL(10,2) NOT NULL,
    annual_price DECIMAL(10,2),
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default pricing (ignore if exists)
INSERT INTO plan_pricing (plan, name, monthly_price, annual_price, description) 
SELECT 'trial', 'Trial', 0, 0, '14-day free trial'
WHERE NOT EXISTS (SELECT 1 FROM plan_pricing WHERE plan = 'trial');

INSERT INTO plan_pricing (plan, name, monthly_price, annual_price, description) 
SELECT 'starter', 'Starter', 49.00, 490.00, 'For small operations'
WHERE NOT EXISTS (SELECT 1 FROM plan_pricing WHERE plan = 'starter');

INSERT INTO plan_pricing (plan, name, monthly_price, annual_price, description) 
SELECT 'professional', 'Professional', 149.00, 1490.00, 'For growing companies'
WHERE NOT EXISTS (SELECT 1 FROM plan_pricing WHERE plan = 'professional');

INSERT INTO plan_pricing (plan, name, monthly_price, annual_price, description) 
SELECT 'enterprise', 'Enterprise', 499.00, 4990.00, 'For large distributors'
WHERE NOT EXISTS (SELECT 1 FROM plan_pricing WHERE plan = 'enterprise');

-- Add billing fields to companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS balance DECIMAL(10,2) DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_email VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_pay BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_method_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_day INTEGER DEFAULT 1;

-- =====================================================
-- 3. CUSTOMER TRANSACTIONS TABLE (Account Ledger)
-- =====================================================

CREATE TABLE IF NOT EXISTS customer_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    
    -- Transaction details
    transaction_type VARCHAR(20) NOT NULL, -- delivery, payment, credit, refund, adjustment, service
    amount DECIMAL(12, 2) NOT NULL, -- positive = charge to customer, negative = payment/credit
    
    -- Delivery-specific fields
    items_delivered INTEGER DEFAULT 0,
    items_collected INTEGER DEFAULT 0, -- empties returned
    
    -- Reference to source
    reference_type VARCHAR(20), -- route_run_stop, manual, import
    reference_id UUID,
    
    -- Metadata
    description TEXT,
    notes TEXT,
    
    -- Payment details (for payment transactions)
    payment_method VARCHAR(50), -- cash, check, card, ach, credit
    payment_reference VARCHAR(100), -- check number, transaction ID, etc.
    
    -- Audit
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexes will help with account history queries
    transaction_date DATE DEFAULT CURRENT_DATE
);

-- Add account fields to customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_balance DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(20) DEFAULT 'net30';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_payment_date DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_payment_amount DECIMAL(12, 2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_delivery_date DATE;

-- Add delivery model tracking to route_run_stops
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS delivery_model VARCHAR(20);
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS items_total DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_collected DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_refunded DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS items_delivered INTEGER DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS items_collected INTEGER DEFAULT 0;

-- Add items tracking to route_runs for real-time totals
ALTER TABLE route_runs ADD COLUMN IF NOT EXISTS total_items_delivered INTEGER DEFAULT 0;
ALTER TABLE route_runs ADD COLUMN IF NOT EXISTS total_items_collected INTEGER DEFAULT 0;

-- Trigger to auto-update customer balance
CREATE OR REPLACE FUNCTION update_customer_balance()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE customers 
    SET account_balance = (
        SELECT COALESCE(SUM(amount), 0)
        FROM customer_transactions 
        WHERE customer_id = NEW.customer_id
    )
    WHERE id = NEW.customer_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_customer_balance ON customer_transactions;
CREATE TRIGGER trg_update_customer_balance
    AFTER INSERT ON customer_transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_customer_balance();

-- View for customer account summary
CREATE OR REPLACE VIEW customer_account_summary AS
SELECT 
    c.id,
    c.company_id,
    c.code,
    c.name,
    c.account_balance,
    c.credit_limit,
    c.payment_terms,
    c.last_delivery_date,
    c.last_payment_date,
    c.last_payment_amount,
    COUNT(DISTINCT ct.id) FILTER (WHERE ct.transaction_type = 'delivery') as total_deliveries,
    COALESCE(SUM(ct.amount) FILTER (WHERE ct.transaction_type = 'delivery'), 0) as total_delivery_charges,
    COALESCE(SUM(ct.amount) FILTER (WHERE ct.transaction_type = 'payment'), 0) as total_payments
FROM customers c
LEFT JOIN customer_transactions ct ON c.id = ct.customer_id
GROUP BY c.id;

-- =====================================================
-- 4. INDEXES FOR PERFORMANCE
-- =====================================================

-- Billing indexes
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ledger_company ON billing_ledger(company_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON billing_ledger(created_at);

-- Customer transaction indexes
CREATE INDEX IF NOT EXISTS idx_customer_transactions_customer ON customer_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_transactions_company ON customer_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_transactions_date ON customer_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_customer_transactions_type ON customer_transactions(transaction_type);

-- =====================================================
-- 5. INVOICE NUMBER GENERATOR FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS VARCHAR(50) AS $$
DECLARE
    new_number VARCHAR(50);
    year_month VARCHAR(6);
    seq_num INTEGER;
BEGIN
    year_month := TO_CHAR(CURRENT_DATE, 'YYYYMM');
    SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 12) AS INTEGER)), 0) + 1
    INTO seq_num
    FROM invoices
    WHERE invoice_number LIKE 'INV-' || year_month || '-%';
    new_number := 'INV-' || year_month || '-' || LPAD(seq_num::TEXT, 4, '0');
    RETURN new_number;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 7. DC INVENTORY - Product stock at each Distribution Center
-- =====================================================
-- Tracks quantity of each product available at each DC
-- Updated when trucks load/unload products

CREATE TABLE IF NOT EXISTS dc_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID NOT NULL REFERENCES distribution_centers(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity_on_hand INTEGER DEFAULT 0,          -- Current stock level
    reorder_level INTEGER DEFAULT 0,             -- Alert when stock falls below this
    max_capacity INTEGER DEFAULT 0,              -- Maximum storage capacity
    last_restocked_at TIMESTAMP,                 -- Last time inventory was added
    last_depleted_at TIMESTAMP,                  -- Last time inventory was removed
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dc_id, product_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_dc_inventory_dc ON dc_inventory(dc_id);
CREATE INDEX IF NOT EXISTS idx_dc_inventory_product ON dc_inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_dc_inventory_low_stock ON dc_inventory(dc_id) WHERE quantity_on_hand <= reorder_level;

-- =====================================================
-- VERIFICATION
-- =====================================================
-- Run this to verify all tables exist:

DO $$
DECLARE
    missing_tables TEXT := '';
BEGIN
    -- Check required tables
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'site_settings') THEN
        missing_tables := missing_tables || 'site_settings, ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'invoices') THEN
        missing_tables := missing_tables || 'invoices, ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payments') THEN
        missing_tables := missing_tables || 'payments, ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_ledger') THEN
        missing_tables := missing_tables || 'billing_ledger, ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'plan_pricing') THEN
        missing_tables := missing_tables || 'plan_pricing, ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_transactions') THEN
        missing_tables := missing_tables || 'customer_transactions, ';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'dc_inventory') THEN
        missing_tables := missing_tables || 'dc_inventory, ';
    END IF;
    
    IF missing_tables = '' THEN
        RAISE NOTICE '✅ All required tables exist!';
    ELSE
        RAISE NOTICE '❌ Missing tables: %', TRIM(TRAILING ', ' FROM missing_tables);
    END IF;
END $$;

-- Show table counts for verification
SELECT 'site_settings' as table_name, COUNT(*) as row_count FROM site_settings
UNION ALL SELECT 'invoices', COUNT(*) FROM invoices
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'billing_ledger', COUNT(*) FROM billing_ledger
UNION ALL SELECT 'plan_pricing', COUNT(*) FROM plan_pricing
UNION ALL SELECT 'customer_transactions', COUNT(*) FROM customer_transactions
UNION ALL SELECT 'dc_inventory', COUNT(*) FROM dc_inventory;

-- =====================================================
-- 8. PREDICTIVE ORDERING SYSTEM
-- =====================================================
-- Tracks customer consumption patterns and predicts future orders
-- Uses historical data + seasonal adjustments

-- Seasonal adjustment factors (by month)
CREATE TABLE IF NOT EXISTS seasonal_factors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
    factor DECIMAL(4,2) NOT NULL DEFAULT 1.00, -- 1.5 = 50% more, 0.7 = 30% less
    product_category VARCHAR(100), -- NULL = applies to all products
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, month, product_category)
);

-- Default seasonal factors for propane (heating fuel pattern)
-- Winter peak, summer low
INSERT INTO seasonal_factors (company_id, month, factor, notes)
SELECT c.id, m.month, m.factor, m.notes
FROM companies c
CROSS JOIN (VALUES
    (1, 1.80, 'January - Peak winter'),
    (2, 1.70, 'February - Heavy heating'),
    (3, 1.40, 'March - Late winter'),
    (4, 0.90, 'April - Spring transition'),
    (5, 0.60, 'May - Low usage'),
    (6, 0.50, 'June - Summer low'),
    (7, 0.50, 'July - Summer low'),
    (8, 0.55, 'August - Late summer'),
    (9, 0.75, 'September - Fall transition'),
    (10, 1.10, 'October - Early heating'),
    (11, 1.50, 'November - Heating season'),
    (12, 1.75, 'December - Winter peak')
) AS m(month, factor, notes)
WHERE NOT EXISTS (
    SELECT 1 FROM seasonal_factors sf 
    WHERE sf.company_id = c.id AND sf.month = m.month AND sf.product_category IS NULL
);

-- Customer consumption history (aggregated from deliveries)
CREATE TABLE IF NOT EXISTS customer_consumption (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    
    -- Time period
    year INTEGER NOT NULL,
    month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
    
    -- Consumption metrics
    total_gallons DECIMAL(12,2) DEFAULT 0,
    total_items INTEGER DEFAULT 0,
    delivery_count INTEGER DEFAULT 0,
    total_revenue DECIMAL(12,2) DEFAULT 0,
    
    -- Calculated averages
    avg_gallons_per_delivery DECIMAL(10,2),
    avg_days_between_deliveries DECIMAL(8,2),
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id, year, month)
);

-- Customer prediction cache (recalculated periodically)
CREATE TABLE IF NOT EXISTS customer_predictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    
    -- Current state
    last_delivery_date DATE,
    last_delivery_gallons DECIMAL(10,2),
    days_since_delivery INTEGER,
    
    -- Consumption patterns (calculated)
    avg_daily_consumption DECIMAL(8,4), -- gallons/day or items/day
    consumption_std_dev DECIMAL(8,4),   -- variability
    delivery_frequency_days DECIMAL(8,2), -- avg days between deliveries
    
    -- Seasonal adjusted consumption
    current_seasonal_factor DECIMAL(4,2),
    adjusted_daily_consumption DECIMAL(8,4),
    
    -- Predictions
    predicted_next_order_date DATE,
    predicted_quantity DECIMAL(10,2),
    predicted_revenue DECIMAL(10,2),
    urgency_score INTEGER DEFAULT 50, -- 0-100 (100 = order now!)
    confidence_score INTEGER DEFAULT 50, -- 0-100 (based on data quality)
    
    -- Recommendation
    recommendation VARCHAR(50), -- 'schedule_now', 'schedule_soon', 'monitor', 'no_action'
    recommendation_reason TEXT,
    
    -- Calculation metadata
    data_points_used INTEGER DEFAULT 0,
    calculation_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(customer_id)
);

-- Add prediction fields to customers table
ALTER TABLE customers ADD COLUMN IF NOT EXISTS predicted_next_order DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS predicted_quantity DECIMAL(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS urgency_score INTEGER DEFAULT 50;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avg_consumption_rate DECIMAL(8,4);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS delivery_frequency_days INTEGER;

-- Indexes for prediction queries
CREATE INDEX IF NOT EXISTS idx_seasonal_factors_company ON seasonal_factors(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_consumption_customer ON customer_consumption(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_consumption_period ON customer_consumption(year, month);
CREATE INDEX IF NOT EXISTS idx_customer_predictions_company ON customer_predictions(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_predictions_urgency ON customer_predictions(urgency_score DESC);
CREATE INDEX IF NOT EXISTS idx_customer_predictions_next_order ON customer_predictions(predicted_next_order_date);
CREATE INDEX IF NOT EXISTS idx_customers_predicted_order ON customers(predicted_next_order);
CREATE INDEX IF NOT EXISTS idx_customers_urgency ON customers(urgency_score DESC);

-- Function to calculate customer consumption from delivery history
CREATE OR REPLACE FUNCTION calculate_customer_consumption(p_company_id UUID, p_customer_id UUID)
RETURNS TABLE (
    avg_daily_consumption DECIMAL,
    avg_delivery_gallons DECIMAL,
    delivery_frequency_days DECIMAL,
    total_deliveries INTEGER,
    data_quality_score INTEGER
) AS $$
DECLARE
    v_deliveries RECORD;
    v_total_gallons DECIMAL := 0;
    v_total_days INTEGER := 0;
    v_delivery_count INTEGER := 0;
    v_prev_date DATE := NULL;
    v_first_date DATE := NULL;
    v_last_date DATE := NULL;
BEGIN
    -- Get delivery history from route_run_stops
    FOR v_deliveries IN
        SELECT 
            rrs.completed_at::DATE as delivery_date,
            COALESCE(rrs.gallons_delivered, 0) as gallons
        FROM route_run_stops rrs
        JOIN route_runs rr ON rrs.route_run_id = rr.id
        WHERE rr.company_id = p_company_id
        AND rrs.customer_id = p_customer_id
        AND rrs.status = 'completed'
        AND rrs.completed_at IS NOT NULL
        ORDER BY rrs.completed_at
    LOOP
        v_delivery_count := v_delivery_count + 1;
        v_total_gallons := v_total_gallons + v_deliveries.gallons;
        
        IF v_first_date IS NULL THEN
            v_first_date := v_deliveries.delivery_date;
        END IF;
        v_last_date := v_deliveries.delivery_date;
        
        IF v_prev_date IS NOT NULL THEN
            v_total_days := v_total_days + (v_deliveries.delivery_date - v_prev_date);
        END IF;
        v_prev_date := v_deliveries.delivery_date;
    END LOOP;
    
    -- Calculate metrics
    IF v_delivery_count >= 2 AND v_total_days > 0 THEN
        avg_daily_consumption := v_total_gallons / GREATEST(v_total_days, 1);
        avg_delivery_gallons := v_total_gallons / v_delivery_count;
        delivery_frequency_days := v_total_days::DECIMAL / (v_delivery_count - 1);
        total_deliveries := v_delivery_count;
        -- Data quality: more deliveries = higher confidence
        data_quality_score := LEAST(100, v_delivery_count * 10);
    ELSE
        avg_daily_consumption := 0;
        avg_delivery_gallons := 0;
        delivery_frequency_days := 30; -- Default assumption
        total_deliveries := v_delivery_count;
        data_quality_score := v_delivery_count * 5;
    END IF;
    
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- Function to update all customer predictions for a company
CREATE OR REPLACE FUNCTION update_customer_predictions(p_company_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_customer RECORD;
    v_consumption RECORD;
    v_seasonal_factor DECIMAL;
    v_current_month INTEGER;
    v_days_since INTEGER;
    v_predicted_date DATE;
    v_urgency INTEGER;
    v_recommendation VARCHAR(50);
    v_reason TEXT;
    v_count INTEGER := 0;
BEGIN
    v_current_month := EXTRACT(MONTH FROM CURRENT_DATE);
    
    -- Get seasonal factor for current month
    SELECT COALESCE(factor, 1.0) INTO v_seasonal_factor
    FROM seasonal_factors
    WHERE company_id = p_company_id 
    AND month = v_current_month
    AND product_category IS NULL
    LIMIT 1;
    
    IF v_seasonal_factor IS NULL THEN
        v_seasonal_factor := 1.0;
    END IF;
    
    -- Process each customer
    FOR v_customer IN
        SELECT c.id, c.last_delivery_date, c.tank_size
        FROM customers c
        WHERE c.company_id = p_company_id
        AND c.status = 'active'
    LOOP
        -- Calculate consumption patterns
        SELECT * INTO v_consumption
        FROM calculate_customer_consumption(p_company_id, v_customer.id);
        
        -- Calculate days since last delivery
        IF v_customer.last_delivery_date IS NOT NULL THEN
            v_days_since := CURRENT_DATE - v_customer.last_delivery_date;
        ELSE
            v_days_since := 999;
        END IF;
        
        -- Predict next order date
        IF v_consumption.delivery_frequency_days > 0 AND v_customer.last_delivery_date IS NOT NULL THEN
            -- Adjust for seasonality
            v_predicted_date := v_customer.last_delivery_date + 
                (v_consumption.delivery_frequency_days / v_seasonal_factor)::INTEGER;
        ELSE
            v_predicted_date := CURRENT_DATE + 30; -- Default fallback
        END IF;
        
        -- Calculate urgency score (0-100)
        IF v_consumption.delivery_frequency_days > 0 THEN
            v_urgency := LEAST(100, GREATEST(0,
                (v_days_since::DECIMAL / (v_consumption.delivery_frequency_days / v_seasonal_factor) * 100)::INTEGER
            ));
        ELSE
            v_urgency := 50;
        END IF;
        
        -- Determine recommendation
        IF v_urgency >= 90 THEN
            v_recommendation := 'schedule_now';
            v_reason := 'Customer is overdue for delivery based on historical pattern';
        ELSIF v_urgency >= 70 THEN
            v_recommendation := 'schedule_soon';
            v_reason := 'Customer will likely need delivery within ' || 
                (v_predicted_date - CURRENT_DATE) || ' days';
        ELSIF v_urgency >= 40 THEN
            v_recommendation := 'monitor';
            v_reason := 'On track, check again in ' || 
                GREATEST(1, ((v_predicted_date - CURRENT_DATE) / 2)::INTEGER) || ' days';
        ELSE
            v_recommendation := 'no_action';
            v_reason := 'Recently serviced, no action needed';
        END IF;
        
        -- Upsert prediction
        INSERT INTO customer_predictions (
            company_id, customer_id,
            last_delivery_date, last_delivery_gallons, days_since_delivery,
            avg_daily_consumption, delivery_frequency_days,
            current_seasonal_factor, adjusted_daily_consumption,
            predicted_next_order_date, predicted_quantity,
            urgency_score, confidence_score,
            recommendation, recommendation_reason,
            data_points_used, calculation_date
        ) VALUES (
            p_company_id, v_customer.id,
            v_customer.last_delivery_date, v_consumption.avg_delivery_gallons, v_days_since,
            v_consumption.avg_daily_consumption, v_consumption.delivery_frequency_days,
            v_seasonal_factor, v_consumption.avg_daily_consumption * v_seasonal_factor,
            v_predicted_date, v_consumption.avg_delivery_gallons,
            v_urgency, v_consumption.data_quality_score,
            v_recommendation, v_reason,
            v_consumption.total_deliveries, CURRENT_TIMESTAMP
        )
        ON CONFLICT (customer_id) DO UPDATE SET
            last_delivery_date = EXCLUDED.last_delivery_date,
            last_delivery_gallons = EXCLUDED.last_delivery_gallons,
            days_since_delivery = EXCLUDED.days_since_delivery,
            avg_daily_consumption = EXCLUDED.avg_daily_consumption,
            delivery_frequency_days = EXCLUDED.delivery_frequency_days,
            current_seasonal_factor = EXCLUDED.current_seasonal_factor,
            adjusted_daily_consumption = EXCLUDED.adjusted_daily_consumption,
            predicted_next_order_date = EXCLUDED.predicted_next_order_date,
            predicted_quantity = EXCLUDED.predicted_quantity,
            urgency_score = EXCLUDED.urgency_score,
            confidence_score = EXCLUDED.confidence_score,
            recommendation = EXCLUDED.recommendation,
            recommendation_reason = EXCLUDED.recommendation_reason,
            data_points_used = EXCLUDED.data_points_used,
            calculation_date = EXCLUDED.calculation_date;
        
        -- Also update customer table for quick access
        UPDATE customers SET
            predicted_next_order = v_predicted_date,
            predicted_quantity = v_consumption.avg_delivery_gallons,
            urgency_score = v_urgency,
            avg_consumption_rate = v_consumption.avg_daily_consumption,
            delivery_frequency_days = v_consumption.delivery_frequency_days::INTEGER
        WHERE id = v_customer.id;
        
        v_count := v_count + 1;
    END LOOP;
    
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- View for predicted orders (ready for route planning)
CREATE OR REPLACE VIEW predicted_orders AS
SELECT 
    cp.company_id,
    c.id as customer_id,
    c.code as customer_code,
    c.name as customer_name,
    c.address,
    c.city,
    c.state,
    c.lat,
    c.lng,
    c.preferred_dc_id,
    dc.name as dc_name,
    cp.last_delivery_date,
    cp.days_since_delivery,
    cp.predicted_next_order_date,
    cp.predicted_quantity,
    cp.urgency_score,
    cp.confidence_score,
    cp.recommendation,
    cp.recommendation_reason,
    cp.avg_daily_consumption,
    cp.current_seasonal_factor,
    cp.delivery_frequency_days,
    cp.data_points_used,
    cp.calculation_date,
    -- Priority ranking for route planning
    CASE 
        WHEN cp.urgency_score >= 90 THEN 1
        WHEN cp.urgency_score >= 70 THEN 2
        WHEN cp.urgency_score >= 50 THEN 3
        ELSE 4
    END as priority_rank
FROM customer_predictions cp
JOIN customers c ON cp.customer_id = c.id
LEFT JOIN distribution_centers dc ON c.preferred_dc_id = dc.id
WHERE c.status = 'active'
ORDER BY cp.urgency_score DESC;
