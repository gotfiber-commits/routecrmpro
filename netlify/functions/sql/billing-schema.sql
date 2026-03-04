-- Billing System Schema
-- Run this in Neon SQL Editor

-- Invoices table
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    plan VARCHAR(50) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    tax DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, paid, overdue, cancelled
    due_date DATE NOT NULL,
    paid_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payments table
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(50), -- card, bank_transfer, check, manual
    transaction_id VARCHAR(255), -- Stripe payment intent ID or external reference
    status VARCHAR(20) DEFAULT 'completed', -- pending, completed, failed, refunded
    description TEXT,
    processed_by UUID REFERENCES super_admins(id), -- for manual payments
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Billing history / ledger for complete account history
CREATE TABLE billing_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- charge, payment, credit, refund, adjustment
    amount DECIMAL(10,2) NOT NULL, -- positive for charges, negative for payments/credits
    balance DECIMAL(10,2) NOT NULL, -- running balance after this transaction
    description TEXT NOT NULL,
    reference_type VARCHAR(20), -- invoice, payment, manual
    reference_id UUID, -- invoice_id or payment_id
    created_by_type VARCHAR(20), -- super_admin, system, stripe
    created_by_id UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add billing fields to companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS balance DECIMAL(10,2) DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_email VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_pay BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_method_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_day INTEGER DEFAULT 1; -- Day of month for billing (1-28)

-- Plan pricing table (so prices can be changed)
CREATE TABLE plan_pricing (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    monthly_price DECIMAL(10,2) NOT NULL,
    annual_price DECIMAL(10,2),
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default pricing
INSERT INTO plan_pricing (plan, name, monthly_price, annual_price, description) VALUES
('trial', 'Trial', 0, 0, '14-day free trial'),
('starter', 'Starter', 49.00, 490.00, 'For small operations'),
('professional', 'Professional', 149.00, 1490.00, 'For growing companies'),
('enterprise', 'Enterprise', 499.00, 4990.00, 'For large distributors');

-- Indexes
CREATE INDEX idx_invoices_company ON invoices(company_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_payments_company ON payments(company_id);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_ledger_company ON billing_ledger(company_id);
CREATE INDEX idx_ledger_created ON billing_ledger(created_at);

-- Function to generate invoice number
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS VARCHAR(50) AS $$
DECLARE
    new_number VARCHAR(50);
    year_month VARCHAR(6);
    seq_num INTEGER;
BEGIN
    year_month := TO_CHAR(CURRENT_DATE, 'YYYYMM');
    SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 8) AS INTEGER)), 0) + 1
    INTO seq_num
    FROM invoices
    WHERE invoice_number LIKE 'INV-' || year_month || '%';
    new_number := 'INV-' || year_month || '-' || LPAD(seq_num::TEXT, 4, '0');
    RETURN new_number;
END;
$$ LANGUAGE plpgsql;
