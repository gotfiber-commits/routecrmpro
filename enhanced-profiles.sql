-- =====================================================
-- ROUTECRMPRO DEMO ENVIRONMENT SEED DATA
-- Creates a complete demo company with realistic data
-- =====================================================

-- Ensure uuid extension is available
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- First, clean up any existing demo data
DELETE FROM companies WHERE subdomain = 'demo';

-- =====================================================
-- 1. CREATE DEMO COMPANY
-- =====================================================
INSERT INTO companies (id, name, subdomain, email, status, settings)
VALUES (
    'de000000-0000-0000-0000-000000000001',
    'Southeast Propane Distribution',
    'demo',
    'info@southeastpropane.com',
    'active',
    '{"timezone": "America/New_York", "currency": "USD", "units": "gallons"}'
);

-- =====================================================
-- 2. DEMO USER - IMPORTANT!
-- =====================================================
-- The demo user is NOT created by this SQL file.
-- You MUST run the setup-demo endpoint after this SQL:
--
--   https://yoursite.netlify.app/.netlify/functions/auth/setup-demo
--
-- This creates: username=demo, password=admin123
-- The endpoint generates a proper bcrypt hash at runtime.
-- =====================================================

-- =====================================================
-- 3. CREATE 3 DISTRIBUTION CENTERS
-- =====================================================
INSERT INTO distribution_centers (id, company_id, code, name, address, city, state, zip, lat, lng, phone, manager_name, capacity_gallons, status)
VALUES
    ('de000000-0000-0000-0000-dc0000000001', 'de000000-0000-0000-0000-000000000001', 'ATL-DC', 'Atlanta Distribution Center', '1234 Industrial Blvd', 'Atlanta', 'GA', '30301', 33.7490, -84.3880, '(404) 555-0100', 'Marcus Johnson', 500000, 'active'),
    ('de000000-0000-0000-0000-dc0000000002', 'de000000-0000-0000-0000-000000000001', 'BHM-DC', 'Birmingham Distribution Center', '5678 Commerce Way', 'Birmingham', 'AL', '35203', 33.5186, -86.8104, '(205) 555-0200', 'Sarah Williams', 400000, 'active'),
    ('de000000-0000-0000-0000-dc0000000003', 'de000000-0000-0000-0000-000000000001', 'NSH-DC', 'Nashville Distribution Center', '9012 Distribution Dr', 'Nashville', 'TN', '37201', 36.1627, -86.7816, '(615) 555-0300', 'Robert Davis', 450000, 'active');

-- =====================================================
-- 4. CREATE 10 DRIVERS (with comprehensive profiles)
-- =====================================================
INSERT INTO drivers (id, company_id, dc_id, code, name, email, phone, license_number, license_state, license_expiry, cdl_class, cdl_number, cdl_state, cdl_endorsements, hazmat_certified, hazmat_endorsed, hazmat_expiration, tanker_endorsed, twic_card, hire_date, hourly_rate, overtime_rate, pay_type, years_experience, status)
VALUES
    -- Atlanta DC Drivers (4)
    ('de000000-0000-0000-0000-d00000000001', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000001', 'DRV-001', 'James Mitchell', 'j.mitchell@demo.com', '(404) 555-1001', 'GA12345678', 'GA', '2026-08-15', 'A', 'CDL-GA-001', 'GA', 'H, N, T, X', true, true, '2026-08-15', true, true, '2019-03-15', 28.50, 42.75, 'hourly', 8, 'active'),
    ('de000000-0000-0000-0000-d00000000002', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000001', 'DRV-002', 'Michael Thompson', 'm.thompson@demo.com', '(404) 555-1002', 'GA23456789', 'GA', '2026-05-20', 'A', 'CDL-GA-002', 'GA', 'H, N, T', true, true, '2026-05-20', true, false, '2020-06-01', 26.00, 39.00, 'hourly', 5, 'active'),
    ('de000000-0000-0000-0000-d00000000003', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000001', 'DRV-003', 'David Wilson', 'd.wilson@demo.com', '(404) 555-1003', 'GA34567890', 'GA', '2027-01-10', 'B', 'CDL-GA-003', 'GA', 'H, N', true, true, '2027-01-10', true, true, '2021-01-20', 25.00, 37.50, 'hourly', 4, 'active'),
    ('de000000-0000-0000-0000-d00000000004', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000001', 'DRV-004', 'Christopher Brown', 'c.brown@demo.com', '(404) 555-1004', 'GA45678901', 'GA', '2026-11-30', 'A', 'CDL-GA-004', 'GA', 'H, N, T, X', true, true, '2026-11-30', true, true, '2018-09-10', 30.00, 45.00, 'hourly', 10, 'active'),
    
    -- Birmingham DC Drivers (3)
    ('de000000-0000-0000-0000-d00000000005', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000002', 'DRV-005', 'William Anderson', 'w.anderson@demo.com', '(205) 555-2001', 'AL12345678', 'AL', '2026-07-25', 'A', 'CDL-AL-001', 'AL', 'H, N, T', true, true, '2026-07-25', true, false, '2017-04-15', 27.00, 40.50, 'hourly', 9, 'active'),
    ('de000000-0000-0000-0000-d00000000006', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000002', 'DRV-006', 'Joseph Martinez', 'j.martinez@demo.com', '(205) 555-2002', 'AL23456789', 'AL', '2026-09-15', 'A', 'CDL-AL-002', 'AL', 'H, N, T, X', true, true, '2026-09-15', true, true, '2019-11-01', 26.50, 39.75, 'hourly', 6, 'active'),
    ('de000000-0000-0000-0000-d00000000007', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000002', 'DRV-007', 'Daniel Garcia', 'd.garcia@demo.com', '(205) 555-2003', 'AL34567890', 'AL', '2027-03-20', 'B', 'CDL-AL-003', 'AL', 'H, N', true, true, '2027-03-20', true, false, '2022-02-14', 24.00, 36.00, 'hourly', 3, 'active'),
    
    -- Nashville DC Drivers (3)
    ('de000000-0000-0000-0000-d00000000008', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000003', 'DRV-008', 'Andrew Taylor', 'a.taylor@demo.com', '(615) 555-3001', 'TN12345678', 'TN', '2026-06-10', 'A', 'CDL-TN-001', 'TN', 'H, N, T, X', true, true, '2026-06-10', true, true, '2016-08-20', 29.00, 43.50, 'hourly', 12, 'active'),
    ('de000000-0000-0000-0000-d00000000009', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000003', 'DRV-009', 'Ryan Jackson', 'r.jackson@demo.com', '(615) 555-3002', 'TN23456789', 'TN', '2026-12-05', 'A', 'CDL-TN-002', 'TN', 'H, N, T', true, true, '2026-12-05', true, false, '2020-03-01', 26.00, 39.00, 'hourly', 5, 'active'),
    ('de000000-0000-0000-0000-d00000000010', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000003', 'DRV-010', 'Kevin White', 'k.white@demo.com', '(615) 555-3003', 'TN34567890', 'TN', '2027-02-28', 'B', 'CDL-TN-003', 'TN', 'H, N', true, true, '2027-02-28', true, true, '2021-07-15', 25.50, 38.25, 'hourly', 4, 'active');

-- =====================================================
-- 5. CREATE 10 TRUCKS (assigned to drivers)
-- =====================================================
INSERT INTO trucks (id, company_id, dc_id, code, name, make, model, year, vin, license_plate, capacity_gallons, mpg, assigned_driver_id, current_odometer, status)
VALUES
    -- Atlanta DC Trucks (4)
    ('de000000-0000-0000-0000-100000000001', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000001', 'TRK-001', 'Atlanta Truck 1', 'Freightliner', 'M2 106', 2022, '1FVACWDT1NHXX0001', 'GA-TRK-001', 3200, 7.5, 'de000000-0000-0000-0000-d00000000001', 45230, 'active'),
    ('de000000-0000-0000-0000-100000000002', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000001', 'TRK-002', 'Atlanta Truck 2', 'Kenworth', 'T370', 2021, '1NKZL70X1MJ000002', 'GA-TRK-002', 2800, 8.0, 'de000000-0000-0000-0000-d00000000002', 62150, 'active'),
    ('de000000-0000-0000-0000-100000000003', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000001', 'TRK-003', 'Atlanta Truck 3', 'Peterbilt', '348', 2023, '1NPALU0X5ND000003', 'GA-TRK-003', 3000, 7.8, 'de000000-0000-0000-0000-d00000000003', 28450, 'active'),
    ('de000000-0000-0000-0000-100000000004', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000001', 'TRK-004', 'Atlanta Truck 4', 'International', 'HV507', 2022, '1HTMKAAN3NH000004', 'GA-TRK-004', 3500, 7.2, 'de000000-0000-0000-0000-d00000000004', 51890, 'active'),
    
    -- Birmingham DC Trucks (3)
    ('de000000-0000-0000-0000-100000000005', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000002', 'TRK-005', 'Birmingham Truck 1', 'Freightliner', 'M2 106', 2021, '1FVACWDT2LHXX0005', 'AL-TRK-001', 3000, 7.6, 'de000000-0000-0000-0000-d00000000005', 72340, 'active'),
    ('de000000-0000-0000-0000-100000000006', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000002', 'TRK-006', 'Birmingham Truck 2', 'Kenworth', 'T370', 2022, '1NKZL70X2NJ000006', 'AL-TRK-002', 2800, 8.2, 'de000000-0000-0000-0000-d00000000006', 48920, 'active'),
    ('de000000-0000-0000-0000-100000000007', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000002', 'TRK-007', 'Birmingham Truck 3', 'Peterbilt', '348', 2020, '1NPALU0X7LD000007', 'AL-TRK-003', 3200, 7.4, 'de000000-0000-0000-0000-d00000000007', 89560, 'active'),
    
    -- Nashville DC Trucks (3)
    ('de000000-0000-0000-0000-100000000008', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000003', 'TRK-008', 'Nashville Truck 1', 'Freightliner', 'M2 106', 2023, '1FVACWDT3PHXX0008', 'TN-TRK-001', 3400, 7.7, 'de000000-0000-0000-0000-d00000000008', 31240, 'active'),
    ('de000000-0000-0000-0000-100000000009', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000003', 'TRK-009', 'Nashville Truck 2', 'Kenworth', 'T370', 2022, '1NKZL70X9NJ000009', 'TN-TRK-002', 2800, 8.1, 'de000000-0000-0000-0000-d00000000009', 55670, 'active'),
    ('de000000-0000-0000-0000-100000000010', 'de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-dc0000000003', 'TRK-010', 'Nashville Truck 3', 'International', 'HV507', 2021, '1HTMKAAN0MH000010', 'TN-TRK-003', 3000, 7.5, 'de000000-0000-0000-0000-d00000000010', 67890, 'active');

-- =====================================================
-- 6. CREATE 1500 CUSTOMERS (500 per DC)
-- Spread across Southeast US cities
-- =====================================================

-- Helper function to generate customers for a DC
-- Atlanta DC Customers (500) - Georgia, North Florida, South Carolina
DO $$
DECLARE
    i INTEGER;
    cust_id UUID;
    tank_sizes INTEGER[] := ARRAY[120, 250, 500, 1000];
    customer_types TEXT[] := ARRAY['residential', 'residential', 'residential', 'commercial', 'agricultural'];
    ga_cities TEXT[] := ARRAY['Atlanta', 'Marietta', 'Roswell', 'Alpharetta', 'Johns Creek', 'Duluth', 'Lawrenceville', 'Snellville', 'Stone Mountain', 'Decatur', 'Sandy Springs', 'Dunwoody', 'Brookhaven', 'Smyrna', 'Kennesaw', 'Acworth', 'Woodstock', 'Canton', 'Cumming', 'Gainesville', 'Buford', 'Suwanee', 'Sugar Hill', 'Flowery Branch', 'Braselton', 'Athens', 'Monroe', 'Conyers', 'Covington', 'McDonough', 'Stockbridge', 'Griffin', 'Newnan', 'Peachtree City', 'Fayetteville', 'Carrollton', 'Dallas', 'Douglasville', 'Austell', 'Powder Springs'];
    ga_zips TEXT[] := ARRAY['30301', '30060', '30075', '30009', '30097', '30096', '30043', '30078', '30083', '30030', '30328', '30338', '30319', '30080', '30144', '30101', '30188', '30114', '30040', '30501', '30518', '30024', '30518', '30542', '30517', '30601', '30655', '30012', '30014', '30253', '30281', '30223', '30263', '30269', '30214', '30117', '30132', '30134', '30106', '30127'];
    base_lat DECIMAL := 33.7490;
    base_lng DECIMAL := -84.3880;
    first_names TEXT[] := ARRAY['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen'];
    last_names TEXT[] := ARRAY['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris'];
    street_names TEXT[] := ARRAY['Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Birch', 'Willow', 'Hickory', 'Magnolia', 'Dogwood', 'Peach', 'Cherry', 'Walnut', 'Chestnut', 'Spruce', 'Poplar', 'Cypress', 'Sycamore', 'Laurel', 'Holly'];
    street_types TEXT[] := ARRAY['St', 'Ave', 'Rd', 'Dr', 'Ln', 'Way', 'Ct', 'Pl', 'Blvd', 'Circle'];
BEGIN
    FOR i IN 1..500 LOOP
        cust_id := uuid_generate_v4();
        INSERT INTO customers (
            id, company_id, preferred_dc_id, code, name, contact_name, email, phone,
            address, city, state, zip, lat, lng,
            customer_type, tank_size, current_level, price_per_gallon, 
            payment_terms, auto_delivery, minimum_level, status
        ) VALUES (
            cust_id,
            'de000000-0000-0000-0000-000000000001',
            'de000000-0000-0000-0000-dc0000000001',
            'ATL-' || LPAD(i::TEXT, 4, '0'),
            CASE WHEN random() < 0.3 THEN 
                (ARRAY['ABC', 'XYZ', 'Smith', 'Jones', 'Premier', 'Quality', 'First', 'Best', 'Pro', 'Elite'])[floor(random()*10)+1] || ' ' ||
                (ARRAY['Farm', 'Ranch', 'Industries', 'Services', 'Supply', 'Corp', 'LLC', 'Inc', 'Co', 'Enterprise'])[floor(random()*10)+1]
            ELSE
                first_names[floor(random()*20)+1] || ' ' || last_names[floor(random()*20)+1]
            END,
            first_names[floor(random()*20)+1] || ' ' || last_names[floor(random()*20)+1],
            'customer' || i || '.atl@demo.com',
            '(404) 555-' || LPAD((1000 + i)::TEXT, 4, '0'),
            (100 + floor(random()*9900))::TEXT || ' ' || street_names[floor(random()*20)+1] || ' ' || street_types[floor(random()*10)+1],
            ga_cities[floor(random()*40)+1],
            'GA',
            ga_zips[floor(random()*40)+1],
            base_lat + (random() - 0.5) * 1.5,
            base_lng + (random() - 0.5) * 1.5,
            customer_types[floor(random()*5)+1],
            tank_sizes[floor(random()*4)+1],
            floor(random() * 80 + 5),
            2.29 + (random() * 0.50),
            (ARRAY['cod', 'net15', 'net30', 'prepaid'])[floor(random()*4)+1],
            random() < 0.7,
            15 + floor(random() * 15),
            'active'
        );
    END LOOP;
END $$;

-- Birmingham DC Customers (500) - Alabama, Mississippi, West Tennessee
DO $$
DECLARE
    i INTEGER;
    cust_id UUID;
    tank_sizes INTEGER[] := ARRAY[120, 250, 500, 1000];
    customer_types TEXT[] := ARRAY['residential', 'residential', 'residential', 'commercial', 'agricultural'];
    al_cities TEXT[] := ARRAY['Birmingham', 'Hoover', 'Vestavia Hills', 'Homewood', 'Mountain Brook', 'Trussville', 'Gardendale', 'Fultondale', 'Bessemer', 'Hueytown', 'Pelham', 'Helena', 'Alabaster', 'Calera', 'Chelsea', 'Moody', 'Leeds', 'Pell City', 'Oxford', 'Anniston', 'Gadsden', 'Albertville', 'Guntersville', 'Cullman', 'Jasper', 'Tuscaloosa', 'Northport', 'Prattville', 'Millbrook', 'Wetumpka', 'Talladega', 'Sylacauga', 'Alexander City', 'Opelika', 'Auburn', 'Phenix City', 'Dothan', 'Enterprise', 'Troy', 'Montgomery'];
    al_zips TEXT[] := ARRAY['35203', '35226', '35216', '35209', '35213', '35173', '35071', '35068', '35020', '35023', '35124', '35080', '35007', '35040', '35043', '35004', '35094', '35125', '36203', '36201', '35901', '35950', '35976', '35055', '35501', '35401', '35476', '36067', '36054', '36092', '35160', '35150', '35010', '36801', '36830', '36867', '36301', '36330', '36081', '36104'];
    base_lat DECIMAL := 33.5186;
    base_lng DECIMAL := -86.8104;
    first_names TEXT[] := ARRAY['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen'];
    last_names TEXT[] := ARRAY['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris'];
    street_names TEXT[] := ARRAY['Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Birch', 'Willow', 'Hickory', 'Magnolia', 'Dogwood', 'Peach', 'Cherry', 'Walnut', 'Chestnut', 'Spruce', 'Poplar', 'Cypress', 'Sycamore', 'Laurel', 'Holly'];
    street_types TEXT[] := ARRAY['St', 'Ave', 'Rd', 'Dr', 'Ln', 'Way', 'Ct', 'Pl', 'Blvd', 'Circle'];
BEGIN
    FOR i IN 1..500 LOOP
        cust_id := uuid_generate_v4();
        INSERT INTO customers (
            id, company_id, preferred_dc_id, code, name, contact_name, email, phone,
            address, city, state, zip, lat, lng,
            customer_type, tank_size, current_level, price_per_gallon, 
            payment_terms, auto_delivery, minimum_level, status
        ) VALUES (
            cust_id,
            'de000000-0000-0000-0000-000000000001',
            'de000000-0000-0000-0000-dc0000000002',
            'BHM-' || LPAD(i::TEXT, 4, '0'),
            CASE WHEN random() < 0.3 THEN 
                (ARRAY['ABC', 'XYZ', 'Smith', 'Jones', 'Premier', 'Quality', 'First', 'Best', 'Pro', 'Elite'])[floor(random()*10)+1] || ' ' ||
                (ARRAY['Farm', 'Ranch', 'Industries', 'Services', 'Supply', 'Corp', 'LLC', 'Inc', 'Co', 'Enterprise'])[floor(random()*10)+1]
            ELSE
                first_names[floor(random()*20)+1] || ' ' || last_names[floor(random()*20)+1]
            END,
            first_names[floor(random()*20)+1] || ' ' || last_names[floor(random()*20)+1],
            'customer' || i || '.bhm@demo.com',
            '(205) 555-' || LPAD((1000 + i)::TEXT, 4, '0'),
            (100 + floor(random()*9900))::TEXT || ' ' || street_names[floor(random()*20)+1] || ' ' || street_types[floor(random()*10)+1],
            al_cities[floor(random()*40)+1],
            'AL',
            al_zips[floor(random()*40)+1],
            base_lat + (random() - 0.5) * 2.0,
            base_lng + (random() - 0.5) * 2.0,
            customer_types[floor(random()*5)+1],
            tank_sizes[floor(random()*4)+1],
            floor(random() * 80 + 5),
            2.29 + (random() * 0.50),
            (ARRAY['cod', 'net15', 'net30', 'prepaid'])[floor(random()*4)+1],
            random() < 0.7,
            15 + floor(random() * 15),
            'active'
        );
    END LOOP;
END $$;

-- Nashville DC Customers (500) - Tennessee, Kentucky, North Alabama
DO $$
DECLARE
    i INTEGER;
    cust_id UUID;
    tank_sizes INTEGER[] := ARRAY[120, 250, 500, 1000];
    customer_types TEXT[] := ARRAY['residential', 'residential', 'residential', 'commercial', 'agricultural'];
    tn_cities TEXT[] := ARRAY['Nashville', 'Franklin', 'Brentwood', 'Murfreesboro', 'Smyrna', 'La Vergne', 'Hendersonville', 'Gallatin', 'Lebanon', 'Mt Juliet', 'Hermitage', 'Goodlettsville', 'Madison', 'Antioch', 'Bellevue', 'Spring Hill', 'Columbia', 'Shelbyville', 'Tullahoma', 'Manchester', 'Cookeville', 'Crossville', 'Sparta', 'McMinnville', 'Clarksville', 'Springfield', 'Dickson', 'Fairview', 'Ashland City', 'White House', 'Portland', 'Bowling Green', 'Glasgow', 'Hopkinsville', 'Russellville', 'Huntsville', 'Decatur', 'Athens', 'Florence', 'Muscle Shoals'];
    tn_zips TEXT[] := ARRAY['37201', '37064', '37027', '37127', '37167', '37086', '37075', '37066', '37087', '37122', '37076', '37072', '37115', '37013', '37221', '37174', '38401', '37160', '37388', '37355', '38501', '38555', '38583', '37110', '37040', '37172', '37055', '37062', '37015', '37188', '37148', '42101', '42141', '42240', '42276', '35801', '35601', '35611', '35630', '35661'];
    base_lat DECIMAL := 36.1627;
    base_lng DECIMAL := -86.7816;
    first_names TEXT[] := ARRAY['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen'];
    last_names TEXT[] := ARRAY['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris'];
    street_names TEXT[] := ARRAY['Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Birch', 'Willow', 'Hickory', 'Magnolia', 'Dogwood', 'Peach', 'Cherry', 'Walnut', 'Chestnut', 'Spruce', 'Poplar', 'Cypress', 'Sycamore', 'Laurel', 'Holly'];
    street_types TEXT[] := ARRAY['St', 'Ave', 'Rd', 'Dr', 'Ln', 'Way', 'Ct', 'Pl', 'Blvd', 'Circle'];
BEGIN
    FOR i IN 1..500 LOOP
        cust_id := uuid_generate_v4();
        INSERT INTO customers (
            id, company_id, preferred_dc_id, code, name, contact_name, email, phone,
            address, city, state, zip, lat, lng,
            customer_type, tank_size, current_level, price_per_gallon, 
            payment_terms, auto_delivery, minimum_level, status
        ) VALUES (
            cust_id,
            'de000000-0000-0000-0000-000000000001',
            'de000000-0000-0000-0000-dc0000000003',
            'NSH-' || LPAD(i::TEXT, 4, '0'),
            CASE WHEN random() < 0.3 THEN 
                (ARRAY['ABC', 'XYZ', 'Smith', 'Jones', 'Premier', 'Quality', 'First', 'Best', 'Pro', 'Elite'])[floor(random()*10)+1] || ' ' ||
                (ARRAY['Farm', 'Ranch', 'Industries', 'Services', 'Supply', 'Corp', 'LLC', 'Inc', 'Co', 'Enterprise'])[floor(random()*10)+1]
            ELSE
                first_names[floor(random()*20)+1] || ' ' || last_names[floor(random()*20)+1]
            END,
            first_names[floor(random()*20)+1] || ' ' || last_names[floor(random()*20)+1],
            'customer' || i || '.nsh@demo.com',
            '(615) 555-' || LPAD((1000 + i)::TEXT, 4, '0'),
            (100 + floor(random()*9900))::TEXT || ' ' || street_names[floor(random()*20)+1] || ' ' || street_types[floor(random()*10)+1],
            tn_cities[floor(random()*40)+1],
            'TN',
            tn_zips[floor(random()*40)+1],
            base_lat + (random() - 0.5) * 2.0,
            base_lng + (random() - 0.5) * 2.0,
            customer_types[floor(random()*5)+1],
            tank_sizes[floor(random()*4)+1],
            floor(random() * 80 + 5),
            2.29 + (random() * 0.50),
            (ARRAY['cod', 'net15', 'net30', 'prepaid'])[floor(random()*4)+1],
            random() < 0.7,
            15 + floor(random() * 15),
            'active'
        );
    END LOOP;
END $$;

-- =====================================================
-- 7. VERIFY DEMO DATA
-- =====================================================
SELECT 'Demo Company' as entity, COUNT(*) as count FROM companies WHERE subdomain = 'demo'
UNION ALL
SELECT 'Distribution Centers', COUNT(*) FROM distribution_centers WHERE company_id = 'de000000-0000-0000-0000-000000000001'
UNION ALL
SELECT 'Drivers', COUNT(*) FROM drivers WHERE company_id = 'de000000-0000-0000-0000-000000000001'
UNION ALL
SELECT 'Trucks', COUNT(*) FROM trucks WHERE company_id = 'de000000-0000-0000-0000-000000000001'
UNION ALL
SELECT 'Customers', COUNT(*) FROM customers WHERE company_id = 'de000000-0000-0000-0000-000000000001';
