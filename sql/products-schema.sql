-- Products & Services Schema
-- Flexible delivery model supporting gallons, products, services, or mixed

-- =====================================================
-- COMPANY DELIVERY SETTINGS
-- =====================================================

-- Add delivery model to companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS delivery_model VARCHAR(20) DEFAULT 'gallons';
-- Options: 'gallons', 'products', 'services', 'mixed'

ALTER TABLE companies ADD COLUMN IF NOT EXISTS track_empties BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS track_truck_inventory BOOLEAN DEFAULT false;

-- =====================================================
-- PRODUCTS & SERVICES CATALOG
-- =====================================================

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    
    -- Basic Info
    type VARCHAR(20) NOT NULL DEFAULT 'product', -- 'product' or 'service'
    code VARCHAR(50),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100), -- e.g., 'Propane Tanks', 'Accessories', 'Services'
    
    -- Pricing
    unit VARCHAR(50) DEFAULT 'each', -- 'each', 'gallon', 'hour', etc.
    default_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    cost DECIMAL(10,2) DEFAULT 0, -- Company's cost for margin tracking
    
    -- For propane products - gallon equivalent for reporting
    gallon_equivalent DECIMAL(10,2),
    
    -- For bottle exchange
    is_exchangeable BOOLEAN DEFAULT false, -- Can be returned/exchanged
    deposit_amount DECIMAL(10,2) DEFAULT 0,
    
    -- Inventory tracking
    track_inventory BOOLEAN DEFAULT false,
    sku VARCHAR(100),
    
    -- Status
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'inactive', 'discontinued'
    sort_order INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_products_company ON products(company_id);
CREATE INDEX idx_products_type ON products(company_id, type);
CREATE INDEX idx_products_category ON products(company_id, category);

-- =====================================================
-- CUSTOMER-SPECIFIC PRODUCTS & PRICING
-- =====================================================

CREATE TABLE IF NOT EXISTS customer_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    
    -- Customer-specific pricing (NULL = use default)
    custom_price DECIMAL(10,2),
    
    -- Whether this customer can order this product
    is_enabled BOOLEAN DEFAULT true,
    
    -- Customer-specific notes
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(customer_id, product_id)
);

CREATE INDEX idx_customer_products_customer ON customer_products(customer_id);
CREATE INDEX idx_customer_products_product ON customer_products(product_id);

-- =====================================================
-- DELIVERY LINE ITEMS
-- Tracks what was delivered/collected at each stop
-- =====================================================

CREATE TABLE IF NOT EXISTS delivery_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    stop_id UUID NOT NULL REFERENCES route_run_stops(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    
    -- Quantities
    quantity_delivered INTEGER DEFAULT 0,
    quantity_collected INTEGER DEFAULT 0, -- For empties/exchanges
    
    -- Pricing at time of delivery
    unit_price DECIMAL(10,2) NOT NULL,
    line_total DECIMAL(10,2) NOT NULL,
    
    -- For empties
    deposit_collected DECIMAL(10,2) DEFAULT 0,
    deposit_refunded DECIMAL(10,2) DEFAULT 0,
    
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delivery_items_stop ON delivery_items(stop_id);
CREATE INDEX idx_delivery_items_product ON delivery_items(product_id);

-- =====================================================
-- TRUCK INVENTORY
-- Tracks what's on each truck
-- =====================================================

CREATE TABLE IF NOT EXISTS truck_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    truck_id UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    
    -- Current quantity on truck
    quantity INTEGER DEFAULT 0,
    
    -- Par levels for restocking alerts
    par_level INTEGER DEFAULT 0,
    max_level INTEGER DEFAULT 0,
    
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(truck_id, product_id)
);

CREATE INDEX idx_truck_inventory_truck ON truck_inventory(truck_id);

-- =====================================================
-- TRUCK INVENTORY LOG
-- History of inventory changes
-- =====================================================

CREATE TABLE IF NOT EXISTS truck_inventory_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    truck_id UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    
    -- Change details
    change_type VARCHAR(50) NOT NULL, -- 'load', 'delivery', 'return', 'adjustment', 'collection'
    quantity_change INTEGER NOT NULL, -- Positive for adds, negative for removes
    quantity_before INTEGER,
    quantity_after INTEGER,
    
    -- Reference
    stop_id UUID REFERENCES route_run_stops(id),
    run_id UUID REFERENCES route_runs(id),
    user_id UUID REFERENCES users(id),
    
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inventory_log_truck ON truck_inventory_log(truck_id);
CREATE INDEX idx_inventory_log_date ON truck_inventory_log(created_at);

-- =====================================================
-- ROUTE RUN STOPS - Add product delivery tracking
-- =====================================================

ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS delivery_model VARCHAR(20);
-- NULL = use company default, or 'gallons', 'products', 'mixed'

ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS items_total DECIMAL(10,2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_collected DECIMAL(10,2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_refunded DECIMAL(10,2) DEFAULT 0;

-- =====================================================
-- HELPER VIEWS
-- =====================================================

-- Customer products with effective pricing
CREATE OR REPLACE VIEW v_customer_product_pricing AS
SELECT 
    cp.customer_id,
    p.id as product_id,
    p.company_id,
    p.type,
    p.code,
    p.name,
    p.category,
    p.unit,
    COALESCE(cp.custom_price, p.default_price) as effective_price,
    p.default_price,
    cp.custom_price,
    p.gallon_equivalent,
    p.is_exchangeable,
    p.deposit_amount,
    p.status,
    p.sort_order,
    COALESCE(cp.is_enabled, true) as is_enabled
FROM products p
LEFT JOIN customer_products cp ON p.id = cp.product_id
WHERE p.status = 'active';

-- Truck inventory summary
CREATE OR REPLACE VIEW v_truck_inventory_summary AS
SELECT 
    ti.truck_id,
    t.code as truck_code,
    t.name as truck_name,
    p.id as product_id,
    p.code as product_code,
    p.name as product_name,
    p.category,
    ti.quantity,
    ti.par_level,
    ti.max_level,
    CASE 
        WHEN ti.quantity <= 0 THEN 'out_of_stock'
        WHEN ti.quantity < ti.par_level THEN 'low'
        ELSE 'ok'
    END as stock_status
FROM truck_inventory ti
JOIN trucks t ON ti.truck_id = t.id
JOIN products p ON ti.product_id = p.id
WHERE p.status = 'active';

-- =====================================================
-- SEED DEFAULT PRODUCTS FOR EXISTING COMPANIES
-- (Optional - run manually if needed)
-- =====================================================

-- Example: Add standard propane bottles for a company
-- INSERT INTO products (company_id, type, code, name, category, unit, default_price, gallon_equivalent, is_exchangeable, deposit_amount, track_inventory, sort_order)
-- VALUES 
--     ('your-company-id', 'product', '20LB', '20lb Propane Tank', 'Propane Tanks', 'each', 24.99, 4.7, true, 30.00, true, 1),
--     ('your-company-id', 'product', '30LB', '30lb Propane Tank', 'Propane Tanks', 'each', 34.99, 7.0, true, 35.00, true, 2),
--     ('your-company-id', 'product', '40LB', '40lb Propane Tank', 'Propane Tanks', 'each', 44.99, 9.4, true, 40.00, true, 3),
--     ('your-company-id', 'product', '100LB', '100lb Propane Tank', 'Propane Tanks', 'each', 89.99, 23.6, true, 75.00, true, 4),
--     ('your-company-id', 'service', 'INSTALL', 'Tank Installation', 'Services', 'each', 150.00, NULL, false, 0, false, 10),
--     ('your-company-id', 'service', 'LEAK-CHECK', 'Leak Check', 'Services', 'each', 50.00, NULL, false, 0, false, 11);
