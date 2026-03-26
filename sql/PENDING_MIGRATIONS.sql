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

-- Add delivery model tracking to route_run_stops
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS delivery_model VARCHAR(20);
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS items_total DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_collected DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_refunded DECIMAL(12, 2) DEFAULT 0;

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
UNION ALL SELECT 'customer_transactions', COUNT(*) FROM customer_transactions;
