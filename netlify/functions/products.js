// Products & Services API
// Manage product catalog, customer-specific pricing, and truck inventory

const { query } = require('./utils/db');
const { requireAuth, requireRole } = require('./utils/auth');
const { success, error, handleOptions, parseBody } = require('./utils/response');

// Check if products table exists and create if needed
async function ensureProductsTable(companyId) {
    try {
        // Try a simple query to see if table exists
        await query('SELECT 1 FROM products LIMIT 1');
        return true;
    } catch (e) {
        if (e.message.includes('does not exist')) {
            return false;
        }
        throw e;
    }
}

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const authResult = requireAuth(event);
    if (authResult.error) {
        return error(authResult.error, authResult.status);
    }
    
    const user = authResult.user;
    const companyId = user.companyId;
    const path = event.path.replace('/.netlify/functions/products', '');
    const method = event.httpMethod;

    try {
        // Check if products feature is available
        const tableExists = await ensureProductsTable(companyId);
        if (!tableExists) {
            return error('Products feature requires database migration. Please run the products-schema.sql migration in your database.', 400);
        }

        // =====================================================
        // PRODUCTS CATALOG
        // =====================================================

        // GET /products - List all products
        if (method === 'GET' && path === '') {
            return await listProducts(companyId, event);
        }

        // GET /products/categories - List categories
        if (method === 'GET' && path === '/categories') {
            return await getCategories(companyId);
        }

        // GET /products/:id - Get single product
        if (method === 'GET' && path.match(/^\/[a-f0-9-]+$/)) {
            const productId = path.slice(1);
            return await getProduct(companyId, productId);
        }

        // POST /products - Create product
        if (method === 'POST' && path === '') {
            if (!requireRole(user, ['admin'])) {
                return error('Admin access required', 403);
            }
            return await createProduct(companyId, event);
        }

        // PUT /products/:id - Update product
        if (method === 'PUT' && path.match(/^\/[a-f0-9-]+$/)) {
            if (!requireRole(user, ['admin'])) {
                return error('Admin access required', 403);
            }
            const productId = path.slice(1);
            return await updateProduct(companyId, productId, event);
        }

        // DELETE /products/:id - Delete product
        if (method === 'DELETE' && path.match(/^\/[a-f0-9-]+$/)) {
            if (!requireRole(user, ['admin'])) {
                return error('Admin access required', 403);
            }
            const productId = path.slice(1);
            return await deleteProduct(companyId, productId);
        }

        // =====================================================
        // CUSTOMER-SPECIFIC PRODUCTS & PRICING
        // =====================================================

        // GET /products/customer/:customerId - Get products for a customer
        if (method === 'GET' && path.match(/^\/customer\/[a-f0-9-]+$/)) {
            const customerId = path.split('/')[2];
            return await getCustomerProducts(companyId, customerId);
        }

        // PUT /products/customer/:customerId - Update customer products
        if (method === 'PUT' && path.match(/^\/customer\/[a-f0-9-]+$/)) {
            if (!requireRole(user, ['admin', 'dispatch'])) {
                return error('Access denied', 403);
            }
            const customerId = path.split('/')[2];
            return await updateCustomerProducts(companyId, customerId, event);
        }

        // =====================================================
        // TRUCK INVENTORY
        // =====================================================

        // GET /products/inventory/:truckId - Get truck inventory
        if (method === 'GET' && path.match(/^\/inventory\/[a-f0-9-]+$/)) {
            const truckId = path.split('/')[2];
            return await getTruckInventory(companyId, truckId);
        }

        // PUT /products/inventory/:truckId - Update truck inventory
        if (method === 'PUT' && path.match(/^\/inventory\/[a-f0-9-]+$/)) {
            if (!requireRole(user, ['admin', 'dispatch'])) {
                return error('Access denied', 403);
            }
            const truckId = path.split('/')[2];
            return await updateTruckInventory(companyId, truckId, user.userId, event);
        }

        // POST /products/inventory/:truckId/load - Load truck (start of day)
        if (method === 'POST' && path.match(/^\/inventory\/[a-f0-9-]+\/load$/)) {
            const truckId = path.split('/')[2];
            return await loadTruck(companyId, truckId, user.userId, event);
        }

        // GET /products/inventory-log/:truckId - Get inventory history
        if (method === 'GET' && path.match(/^\/inventory-log\/[a-f0-9-]+$/)) {
            const truckId = path.split('/')[2];
            return await getInventoryLog(companyId, truckId, event);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Products API error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};

// =====================================================
// PRODUCTS CATALOG FUNCTIONS
// =====================================================

async function listProducts(companyId, event) {
    const params = event.queryStringParameters || {};
    
    let whereClause = 'WHERE p.company_id = $1';
    const queryParams = [companyId];
    let paramCount = 1;

    if (params.type) {
        paramCount++;
        whereClause += ` AND p.type = $${paramCount}`;
        queryParams.push(params.type);
    }

    if (params.category) {
        paramCount++;
        whereClause += ` AND p.category = $${paramCount}`;
        queryParams.push(params.category);
    }

    if (params.status) {
        paramCount++;
        whereClause += ` AND p.status = $${paramCount}`;
        queryParams.push(params.status);
    } else {
        whereClause += ` AND p.status != 'discontinued'`;
    }

    if (params.search) {
        paramCount++;
        whereClause += ` AND (p.name ILIKE $${paramCount} OR p.code ILIKE $${paramCount})`;
        queryParams.push(`%${params.search}%`);
    }

    const result = await query(
        `SELECT p.*,
                (SELECT COUNT(*) FROM customer_products cp WHERE cp.product_id = p.id) as customer_count,
                (SELECT SUM(quantity) FROM truck_inventory ti WHERE ti.product_id = p.id) as total_inventory
         FROM products p
         ${whereClause}
         ORDER BY p.sort_order, p.category, p.name`,
        queryParams
    );

    return success(result.rows);
}

async function getCategories(companyId) {
    const result = await query(
        `SELECT DISTINCT category 
         FROM products 
         WHERE company_id = $1 AND category IS NOT NULL AND status = 'active'
         ORDER BY category`,
        [companyId]
    );
    return success(result.rows.map(r => r.category));
}

async function getProduct(companyId, productId) {
    const result = await query(
        `SELECT p.*,
                (SELECT COUNT(*) FROM customer_products cp WHERE cp.product_id = p.id) as customer_count,
                (SELECT json_agg(json_build_object(
                    'truck_id', ti.truck_id,
                    'truck_code', t.code,
                    'quantity', ti.quantity,
                    'par_level', ti.par_level
                )) FROM truck_inventory ti 
                JOIN trucks t ON ti.truck_id = t.id 
                WHERE ti.product_id = p.id) as inventory
         FROM products p
         WHERE p.id = $1 AND p.company_id = $2`,
        [productId, companyId]
    );

    if (result.rows.length === 0) {
        return error('Product not found', 404);
    }

    return success(result.rows[0]);
}

async function createProduct(companyId, event) {
    const body = parseBody(event);
    
    const result = await query(
        `INSERT INTO products (
            company_id, type, code, name, description, category,
            unit, default_price, cost, gallon_equivalent,
            is_exchangeable, deposit_amount, track_inventory, sku,
            status, sort_order
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *`,
        [
            companyId,
            body.type || 'product',
            body.code,
            body.name,
            body.description,
            body.category,
            body.unit || 'each',
            body.default_price || 0,
            body.cost || 0,
            body.gallon_equivalent,
            body.is_exchangeable || false,
            body.deposit_amount || 0,
            body.track_inventory || false,
            body.sku,
            body.status || 'active',
            body.sort_order || 0
        ]
    );

    return success(result.rows[0], 201);
}

async function updateProduct(companyId, productId, event) {
    const body = parseBody(event);
    
    const result = await query(
        `UPDATE products SET
            type = COALESCE($1, type),
            code = COALESCE($2, code),
            name = COALESCE($3, name),
            description = $4,
            category = $5,
            unit = COALESCE($6, unit),
            default_price = COALESCE($7, default_price),
            cost = COALESCE($8, cost),
            gallon_equivalent = $9,
            is_exchangeable = COALESCE($10, is_exchangeable),
            deposit_amount = COALESCE($11, deposit_amount),
            track_inventory = COALESCE($12, track_inventory),
            sku = $13,
            status = COALESCE($14, status),
            sort_order = COALESCE($15, sort_order),
            updated_at = NOW()
         WHERE id = $16 AND company_id = $17
         RETURNING *`,
        [
            body.type,
            body.code,
            body.name,
            body.description,
            body.category,
            body.unit,
            body.default_price,
            body.cost,
            body.gallon_equivalent,
            body.is_exchangeable,
            body.deposit_amount,
            body.track_inventory,
            body.sku,
            body.status,
            body.sort_order,
            productId,
            companyId
        ]
    );

    if (result.rows.length === 0) {
        return error('Product not found', 404);
    }

    return success(result.rows[0]);
}

async function deleteProduct(companyId, productId) {
    // Check if product has been used in deliveries
    const usageCheck = await query(
        `SELECT COUNT(*) FROM delivery_items WHERE product_id = $1`,
        [productId]
    );

    if (parseInt(usageCheck.rows[0].count) > 0) {
        // Soft delete - mark as discontinued
        await query(
            `UPDATE products SET status = 'discontinued', updated_at = NOW() 
             WHERE id = $1 AND company_id = $2`,
            [productId, companyId]
        );
        return success({ message: 'Product marked as discontinued (has delivery history)' });
    }

    // Hard delete if never used
    await query(
        `DELETE FROM products WHERE id = $1 AND company_id = $2`,
        [productId, companyId]
    );

    return success({ message: 'Product deleted' });
}

// =====================================================
// CUSTOMER PRODUCTS FUNCTIONS
// =====================================================

async function getCustomerProducts(companyId, customerId) {
    // Get all active products with customer-specific overrides
    const result = await query(
        `SELECT 
            p.id,
            p.type,
            p.code,
            p.name,
            p.category,
            p.unit,
            p.default_price,
            p.gallon_equivalent,
            p.is_exchangeable,
            p.deposit_amount,
            p.sort_order,
            cp.custom_price,
            cp.is_enabled,
            cp.notes,
            COALESCE(cp.custom_price, p.default_price) as effective_price,
            COALESCE(cp.is_enabled, true) as is_available
         FROM products p
         LEFT JOIN customer_products cp ON p.id = cp.product_id AND cp.customer_id = $1
         WHERE p.company_id = $2 AND p.status = 'active'
         ORDER BY p.sort_order, p.category, p.name`,
        [customerId, companyId]
    );

    return success(result.rows);
}

async function updateCustomerProducts(companyId, customerId, event) {
    const body = parseBody(event);
    const products = body.products || [];

    // Verify customer belongs to company
    const customerCheck = await query(
        `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
        [customerId, companyId]
    );
    if (customerCheck.rows.length === 0) {
        return error('Customer not found', 404);
    }

    // Update each product setting
    for (const p of products) {
        await query(
            `INSERT INTO customer_products (company_id, customer_id, product_id, custom_price, is_enabled, notes)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (customer_id, product_id) DO UPDATE SET
                custom_price = $4,
                is_enabled = $5,
                notes = $6,
                updated_at = NOW()`,
            [companyId, customerId, p.product_id, p.custom_price, p.is_enabled, p.notes]
        );
    }

    return success({ message: 'Customer products updated', count: products.length });
}

// =====================================================
// TRUCK INVENTORY FUNCTIONS
// =====================================================

async function getTruckInventory(companyId, truckId) {
    // Verify truck belongs to company
    const truckCheck = await query(
        `SELECT t.*, d.name as driver_name 
         FROM trucks t 
         LEFT JOIN drivers d ON t.assigned_driver_id = d.id
         WHERE t.id = $1 AND t.company_id = $2`,
        [truckId, companyId]
    );
    if (truckCheck.rows.length === 0) {
        return error('Truck not found', 404);
    }

    const inventory = await query(
        `SELECT 
            ti.*,
            p.code as product_code,
            p.name as product_name,
            p.category,
            p.type,
            p.default_price,
            p.is_exchangeable,
            CASE 
                WHEN ti.quantity <= 0 THEN 'out_of_stock'
                WHEN ti.quantity < ti.par_level THEN 'low'
                ELSE 'ok'
            END as stock_status
         FROM truck_inventory ti
         JOIN products p ON ti.product_id = p.id
         WHERE ti.truck_id = $1 AND ti.company_id = $2 AND p.status = 'active'
         ORDER BY p.sort_order, p.category, p.name`,
        [truckId, companyId]
    );

    return success({
        truck: truckCheck.rows[0],
        inventory: inventory.rows
    });
}

async function updateTruckInventory(companyId, truckId, userId, event) {
    const body = parseBody(event);
    const items = body.items || [];
    const changeType = body.change_type || 'adjustment';
    const notes = body.notes || '';

    for (const item of items) {
        // Get current quantity
        const current = await query(
            `SELECT quantity FROM truck_inventory WHERE truck_id = $1 AND product_id = $2`,
            [truckId, item.product_id]
        );
        const currentQty = current.rows.length > 0 ? current.rows[0].quantity : 0;
        const newQty = item.quantity;

        // Upsert inventory
        await query(
            `INSERT INTO truck_inventory (company_id, truck_id, product_id, quantity, par_level, max_level)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (truck_id, product_id) DO UPDATE SET
                quantity = $4,
                par_level = COALESCE($5, truck_inventory.par_level),
                max_level = COALESCE($6, truck_inventory.max_level),
                updated_at = NOW()`,
            [companyId, truckId, item.product_id, newQty, item.par_level, item.max_level]
        );

        // Log the change
        if (currentQty !== newQty) {
            await query(
                `INSERT INTO truck_inventory_log 
                 (company_id, truck_id, product_id, change_type, quantity_change, quantity_before, quantity_after, user_id, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [companyId, truckId, item.product_id, changeType, newQty - currentQty, currentQty, newQty, userId, notes]
            );
        }
    }

    return success({ message: 'Inventory updated', count: items.length });
}

async function loadTruck(companyId, truckId, userId, event) {
    const body = parseBody(event);
    const items = body.items || [];
    const runId = body.run_id;

    for (const item of items) {
        const current = await query(
            `SELECT quantity FROM truck_inventory WHERE truck_id = $1 AND product_id = $2`,
            [truckId, item.product_id]
        );
        const currentQty = current.rows.length > 0 ? current.rows[0].quantity : 0;
        const loadQty = item.quantity || 0;
        const newQty = currentQty + loadQty;

        // Update inventory
        await query(
            `INSERT INTO truck_inventory (company_id, truck_id, product_id, quantity)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (truck_id, product_id) DO UPDATE SET
                quantity = $4,
                updated_at = NOW()`,
            [companyId, truckId, item.product_id, newQty]
        );

        // Log
        if (loadQty > 0) {
            await query(
                `INSERT INTO truck_inventory_log 
                 (company_id, truck_id, product_id, change_type, quantity_change, quantity_before, quantity_after, user_id, run_id, notes)
                 VALUES ($1, $2, $3, 'load', $4, $5, $6, $7, $8, 'Start of day load')`,
                [companyId, truckId, item.product_id, loadQty, currentQty, newQty, userId, runId]
            );
        }
    }

    return success({ message: 'Truck loaded', count: items.length });
}

async function getInventoryLog(companyId, truckId, event) {
    const params = event.queryStringParameters || {};
    const limit = parseInt(params.limit) || 100;
    const days = parseInt(params.days) || 7;

    const result = await query(
        `SELECT 
            til.*,
            p.code as product_code,
            p.name as product_name,
            u.name as user_name
         FROM truck_inventory_log til
         JOIN products p ON til.product_id = p.id
         LEFT JOIN users u ON til.user_id = u.id
         WHERE til.truck_id = $1 AND til.company_id = $2
         AND til.created_at > NOW() - INTERVAL '${days} days'
         ORDER BY til.created_at DESC
         LIMIT $3`,
        [truckId, companyId, limit]
    );

    return success(result.rows);
}

module.exports = { handler: exports.handler };
