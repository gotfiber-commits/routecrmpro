-- Additional billing fields for auto-pay and billing cycles
-- Run this in Neon SQL Editor

-- Add billing cycle day (1-28) to companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_day INTEGER DEFAULT 1 CHECK (billing_day >= 1 AND billing_day <= 28);

-- Add last billed date to track billing cycles
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_billed_at DATE;

-- Add billing contact email (separate from main company email)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_email VARCHAR(255);

-- Add Stripe payment method details for display
ALTER TABLE companies ADD COLUMN IF NOT EXISTS card_last4 VARCHAR(4);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS card_brand VARCHAR(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS card_exp_month INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS card_exp_year INTEGER;

-- Email log to track sent invoices
CREATE TABLE IF NOT EXISTS email_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    email_type VARCHAR(50) NOT NULL, -- invoice, payment_receipt, payment_failed, reminder
    recipient VARCHAR(255) NOT NULL,
    subject VARCHAR(255),
    status VARCHAR(20) DEFAULT 'sent', -- sent, failed, bounced
    provider_id VARCHAR(255), -- Email provider message ID
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_log_company ON email_log(company_id);
CREATE INDEX IF NOT EXISTS idx_email_log_invoice ON email_log(invoice_id);

-- Update plan_pricing with billing info
ALTER TABLE plan_pricing ADD COLUMN IF NOT EXISTS billing_frequency VARCHAR(20) DEFAULT 'monthly';
