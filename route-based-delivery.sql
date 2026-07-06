-- Customer Transactions / Account Ledger
-- Tracks all delivery transactions for billing and account history
-- Run this migration AFTER FULL_MIGRATION.sql

-- Customer transactions ledger
CREATE TABLE IF NOT EXISTS customer_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    
    -- Transaction type: delivery, payment, credit, refund, adjustment, deposit, service
    transaction_type VARCHAR(20) NOT NULL,
    
    -- Amount (positive for charges, negative for payments/credits)
    amount DECIMAL(12, 2) NOT NULL,
    
    -- For deliveries - track quantities
    items_delivered INTEGER DEFAULT 0,  -- Total items delivered
    items_collected INTEGER DEFAULT 0,  -- Total items picked up/returned
    
    -- Reference to source record
    reference_type VARCHAR(20), -- stop, invoice, payment, manual
    reference_id UUID,
    
    -- Description for statements (includes product names for deliveries)
    description TEXT,
    
    -- Who created this transaction
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    
    -- Timestamps
    transaction_date DATE DEFAULT CURRENT_DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_customer_trans_company ON customer_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_trans_customer ON customer_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_trans_date ON customer_transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_customer_trans_type ON customer_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_customer_trans_ref ON customer_transactions(reference_type, reference_id);

-- Add account balance tracking to customers table
ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_balance DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(20) DEFAULT 'net30'; -- cod, net15, net30, net60
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_payment_date DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_payment_amount DECIMAL(12, 2);

-- Add columns to route_run_stops that might be missing
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS delivery_model VARCHAR(20);
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS items_total DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_collected DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_refunded DECIMAL(12, 2) DEFAULT 0;

-- Function to update customer balance when transaction is inserted
CREATE OR REPLACE FUNCTION update_customer_balance()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE customers 
    SET account_balance = account_balance + NEW.amount,
        updated_at = NOW()
    WHERE id = NEW.customer_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update balance
DROP TRIGGER IF EXISTS trg_update_customer_balance ON customer_transactions;
CREATE TRIGGER trg_update_customer_balance
    AFTER INSERT ON customer_transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_customer_balance();

-- View for customer account summary
CREATE OR REPLACE VIEW customer_account_summary AS
SELECT 
    c.id as customer_id,
    c.company_id,
    c.name as customer_name,
    c.code as customer_code,
    c.account_balance,
    c.credit_limit,
    c.payment_terms,
    c.last_delivery_date,
    c.last_payment_date,
    c.last_payment_amount,
    COALESCE(SUM(CASE WHEN ct.transaction_type = 'delivery' THEN ct.amount ELSE 0 END), 0) as total_deliveries,
    COALESCE(SUM(CASE WHEN ct.transaction_type = 'payment' THEN ABS(ct.amount) ELSE 0 END), 0) as total_payments,
    COUNT(DISTINCT CASE WHEN ct.transaction_type = 'delivery' THEN ct.id END) as delivery_count
FROM customers c
LEFT JOIN customer_transactions ct ON c.id = ct.customer_id
GROUP BY c.id, c.company_id, c.name, c.code, c.account_balance, c.credit_limit, 
         c.payment_terms, c.last_delivery_date, c.last_payment_date, c.last_payment_amount;

-- Sample query to get customer statement
-- SELECT * FROM customer_transactions 
-- WHERE customer_id = 'xxx' 
-- ORDER BY transaction_date DESC, created_at DESC;

-- Sample query to get delivery history with details
-- SELECT 
--     ct.*, 
--     rrs.gallons_delivered, 
--     rrs.tank_level_before, 
--     rrs.tank_level_after,
--     rr.scheduled_date,
--     d.name as driver_name
-- FROM customer_transactions ct
-- LEFT JOIN route_run_stops rrs ON ct.reference_id = rrs.id AND ct.reference_type = 'stop'
-- LEFT JOIN route_runs rr ON rrs.run_id = rr.id
-- LEFT JOIN drivers d ON rr.driver_id = d.id
-- WHERE ct.customer_id = 'xxx'
-- ORDER BY ct.transaction_date DESC;

COMMENT ON TABLE customer_transactions IS 'Ledger of all customer account activity for billing and history';
COMMENT ON COLUMN customer_transactions.transaction_type IS 'delivery=charge for delivery, payment=customer payment received, credit=credit issued, refund=refund issued, adjustment=manual adjustment, deposit=tank deposit';
COMMENT ON COLUMN customer_transactions.amount IS 'Positive for charges (deliveries), negative for payments/credits';
