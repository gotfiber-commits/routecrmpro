// Reports API - Analytics and reporting for delivery operations
const { query } = require('./utils/db');
const { requireAuth, requireRole } = require('./utils/auth');
const { success, error, handleOptions, parseBody } = require('./utils/response');

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/reports', '');
    const method = event.httpMethod;

    try {
        // Auth required
        const authResult = requireAuth(event);
        if (authResult.error) {
            return error(authResult.error, authResult.status);
        }
        
        const user = authResult.user;
        const companyId = user.companyId;
        const params = event.queryStringParameters || {};

        // Date range defaults to last 30 days
        const endDate = params.end_date || new Date().toISOString().split('T')[0];
        const startDate = params.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        // GET /reports/dashboard - Executive dashboard summary
        if (method === 'GET' && path === '/dashboard') {
            return await getDashboardReport(companyId, startDate, endDate, user);
        }

        // GET /reports/routes - Route performance report
        if (method === 'GET' && path === '/routes') {
            return await getRouteReport(companyId, startDate, endDate, user);
        }

        // GET /reports/drivers - Driver performance report
        if (method === 'GET' && path === '/drivers') {
            return await getDriverReport(companyId, startDate, endDate, user);
        }

        // GET /reports/trucks - Truck/Fleet report
        if (method === 'GET' && path === '/trucks') {
            return await getTruckReport(companyId, startDate, endDate, user);
        }

        // GET /reports/customers - Customer delivery report
        if (method === 'GET' && path === '/customers') {
            return await getCustomerReport(companyId, startDate, endDate, user);
        }

        // GET /reports/financial - Revenue and cost report
        if (method === 'GET' && path === '/financial') {
            return await getFinancialReport(companyId, startDate, endDate, user);
        }

        // GET /reports/daily - Daily summary report
        if (method === 'GET' && path === '/daily') {
            return await getDailyReport(companyId, startDate, endDate, user);
        }

        // GET /reports/products - Product sales report
        if (method === 'GET' && path === '/products') {
            return await getProductsReport(companyId, startDate, endDate, user);
        }

        // GET /reports/export/:type - Export report as CSV
        if (method === 'GET' && path.startsWith('/export/')) {
            const reportType = path.replace('/export/', '');
            return await exportReportCSV(companyId, reportType, startDate, endDate, user);
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Reports API error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};

// =====================================================
// EXECUTIVE DASHBOARD REPORT
// =====================================================
async function getDashboardReport(companyId, startDate, endDate, user) {
    let dcFilter = '';
    const baseParams = [companyId, startDate, endDate];
    if (user.dcId) {
        dcFilter = ' AND rr.dc_id = $4';
        baseParams.push(user.dcId);
    }

    // Overall route stats
    const routeStats = await query(`
        SELECT 
            COUNT(*) as total_routes,
            COUNT(*) FILTER (WHERE status = 'completed') as completed_routes,
            COUNT(*) FILTER (WHERE status = 'in_progress') as active_routes,
            COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_routes,
            COALESCE(SUM(total_stops), 0) as total_stops,
            COALESCE(SUM(stops_completed), 0) as stops_completed,
            COALESCE(SUM(estimated_miles), 0) as total_miles,
            COALESCE(SUM(total_gallons_delivered), 0) as total_gallons,
            COALESCE(SUM(total_revenue), 0) as total_revenue,
            COALESCE(SUM(estimated_fuel_cost), 0) as total_fuel_cost,
            COALESCE(SUM(estimated_driver_cost), 0) as total_driver_cost,
            COALESCE(SUM(estimated_total_cost), 0) as total_cost,
            COALESCE(AVG(estimated_miles), 0) as avg_miles_per_route,
            COALESCE(AVG(total_stops), 0) as avg_stops_per_route
        FROM route_runs rr
        WHERE rr.company_id = $1 
        AND rr.scheduled_date BETWEEN $2 AND $3
        ${dcFilter}
    `, baseParams);

    // Product delivery stats (from delivery_items)
    const productStats = await query(`
        SELECT 
            COALESCE(SUM(di.qty_delivered), 0) as total_items_delivered,
            COALESCE(SUM(di.qty_collected), 0) as total_items_collected,
            COALESCE(SUM(di.line_total), 0) as total_product_revenue,
            COALESCE(SUM(di.deposit_collected), 0) as total_deposits_collected,
            COALESCE(SUM(di.deposit_refunded), 0) as total_deposits_refunded,
            COUNT(DISTINCT di.product_id) as unique_products_sold
        FROM delivery_items di
        JOIN route_run_stops rrs ON di.route_run_stop_id = rrs.id
        JOIN route_runs rr ON rrs.run_id = rr.id
        WHERE rr.company_id = $1 
        AND rr.scheduled_date BETWEEN $2 AND $3
        ${dcFilter}
    `, baseParams);

    // Customer account summary
    const accountStats = await query(`
        SELECT 
            COALESCE(SUM(account_balance), 0) as total_outstanding,
            COUNT(*) FILTER (WHERE account_balance > 0) as customers_with_balance,
            COUNT(*) FILTER (WHERE account_balance > credit_limit AND credit_limit > 0) as over_credit_limit
        FROM customers
        WHERE company_id = $1 AND status = 'active'
    `, [companyId]);

    // Delivery completion rate
    const completionRate = await query(`
        SELECT 
            COUNT(*) FILTER (WHERE status = 'completed') as completed,
            COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
            COUNT(*) as total
        FROM route_run_stops rrs
        JOIN route_runs rr ON rrs.run_id = rr.id
        WHERE rr.company_id = $1 
        AND rr.scheduled_date BETWEEN $2 AND $3
        ${dcFilter}
    `, baseParams);

    // Top performing drivers
    const topDrivers = await query(`
        SELECT 
            d.id, d.name, d.code,
            COUNT(DISTINCT rr.id) as routes_completed,
            COALESCE(SUM(rr.stops_completed), 0) as total_deliveries,
            COALESCE(SUM(rr.total_gallons_delivered), 0) as total_gallons,
            COALESCE(SUM(rr.total_revenue), 0) as total_revenue,
            COALESCE(SUM(rr.estimated_miles), 0) as total_miles
        FROM drivers d
        LEFT JOIN route_runs rr ON d.id = rr.driver_id 
            AND rr.scheduled_date BETWEEN $2 AND $3
            AND rr.status = 'completed'
        WHERE d.company_id = $1 AND d.status = 'active'
        GROUP BY d.id, d.name, d.code
        ORDER BY total_deliveries DESC
        LIMIT 5
    `, [companyId, startDate, endDate]);

    // Truck utilization
    const truckStats = await query(`
        SELECT 
            COUNT(DISTINCT t.id) as total_trucks,
            COUNT(DISTINCT rr.truck_id) as trucks_used,
            COALESCE(SUM(rr.estimated_miles), 0) as total_fleet_miles,
            COALESCE(SUM(rr.estimated_fuel_gallons), 0) as total_fuel_used,
            COALESCE(AVG(t.avg_mpg), 0) as avg_fleet_mpg
        FROM trucks t
        LEFT JOIN route_runs rr ON t.id = rr.truck_id 
            AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE t.company_id = $1 AND t.status = 'active'
    `, [companyId, startDate, endDate]);

    // Top products sold
    const topProducts = await query(`
        SELECT 
            p.id, p.name, p.code,
            COALESCE(SUM(di.qty_delivered), 0) as qty_sold,
            COALESCE(SUM(di.line_total), 0) as revenue
        FROM products p
        LEFT JOIN delivery_items di ON p.id = di.product_id
        LEFT JOIN route_run_stops rrs ON di.route_run_stop_id = rrs.id
        LEFT JOIN route_runs rr ON rrs.run_id = rr.id 
            AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE p.company_id = $1 AND p.status = 'active'
        GROUP BY p.id, p.name, p.code
        ORDER BY revenue DESC
        LIMIT 5
    `, [companyId, startDate, endDate]);

    // Daily trend
    const dailyTrend = await query(`
        SELECT 
            rr.scheduled_date::date as date,
            COUNT(*) as routes,
            COALESCE(SUM(stops_completed), 0) as deliveries,
            COALESCE(SUM(total_gallons_delivered), 0) as gallons,
            COALESCE(SUM(total_revenue), 0) as revenue
        FROM route_runs rr
        WHERE rr.company_id = $1 
        AND rr.scheduled_date BETWEEN $2 AND $3
        ${dcFilter}
        GROUP BY rr.scheduled_date::date
        ORDER BY date DESC
        LIMIT 7
    `, baseParams);

    const stats = routeStats.rows[0];
    const products = productStats.rows[0] || {};
    const accounts = accountStats.rows[0] || {};
    const completion = completionRate.rows[0];
    const trucks = truckStats.rows[0];

    return success({
        period: { start_date: startDate, end_date: endDate },
        summary: {
            total_routes: parseInt(stats.total_routes) || 0,
            completed_routes: parseInt(stats.completed_routes) || 0,
            active_routes: parseInt(stats.active_routes) || 0,
            cancelled_routes: parseInt(stats.cancelled_routes) || 0,
            completion_rate: stats.total_routes > 0 ? ((stats.completed_routes / stats.total_routes) * 100).toFixed(1) : 0,
            total_stops: parseInt(stats.total_stops) || 0,
            stops_completed: parseInt(stats.stops_completed) || 0,
            delivery_success_rate: completion.total > 0 ? ((completion.completed / completion.total) * 100).toFixed(1) : 0
        },
        metrics: {
            total_miles: parseFloat(stats.total_miles) || 0,
            total_gallons: parseFloat(stats.total_gallons) || 0,
            total_revenue: parseFloat(stats.total_revenue) || 0,
            total_cost: parseFloat(stats.total_cost) || 0,
            profit: (parseFloat(stats.total_revenue) || 0) - (parseFloat(stats.total_cost) || 0),
            profit_margin: stats.total_revenue > 0 ? (((stats.total_revenue - stats.total_cost) / stats.total_revenue) * 100).toFixed(1) : 0,
            avg_miles_per_route: parseFloat(stats.avg_miles_per_route) || 0,
            avg_stops_per_route: parseFloat(stats.avg_stops_per_route) || 0,
            revenue_per_gallon: stats.total_gallons > 0 ? (stats.total_revenue / stats.total_gallons).toFixed(2) : 0,
            cost_per_mile: stats.total_miles > 0 ? (stats.total_cost / stats.total_miles).toFixed(2) : 0
        },
        product_metrics: {
            total_items_delivered: parseInt(products.total_items_delivered) || 0,
            total_items_collected: parseInt(products.total_items_collected) || 0,
            total_product_revenue: parseFloat(products.total_product_revenue) || 0,
            total_deposits_collected: parseFloat(products.total_deposits_collected) || 0,
            total_deposits_refunded: parseFloat(products.total_deposits_refunded) || 0,
            net_deposits: (parseFloat(products.total_deposits_collected) || 0) - (parseFloat(products.total_deposits_refunded) || 0),
            unique_products_sold: parseInt(products.unique_products_sold) || 0
        },
        accounts_receivable: {
            total_outstanding: parseFloat(accounts.total_outstanding) || 0,
            customers_with_balance: parseInt(accounts.customers_with_balance) || 0,
            over_credit_limit: parseInt(accounts.over_credit_limit) || 0
        },
        fleet: {
            total_trucks: parseInt(trucks.total_trucks) || 0,
            trucks_used: parseInt(trucks.trucks_used) || 0,
            utilization: trucks.total_trucks > 0 ? ((trucks.trucks_used / trucks.total_trucks) * 100).toFixed(1) : 0,
            total_fleet_miles: parseFloat(trucks.total_fleet_miles) || 0,
            avg_mpg: parseFloat(trucks.avg_fleet_mpg) || 0
        },
        top_drivers: topDrivers.rows,
        top_products: topProducts.rows,
        daily_trend: dailyTrend.rows
    });
}

// =====================================================
// ROUTE PERFORMANCE REPORT
// =====================================================
async function getRouteReport(companyId, startDate, endDate, user) {
    let dcFilter = '';
    const params = [companyId, startDate, endDate];
    if (user.dcId) {
        dcFilter = ' AND rr.dc_id = $4';
        params.push(user.dcId);
    }

    const routes = await query(`
        SELECT 
            rr.id, rr.name, rr.scheduled_date, rr.status,
            rr.total_stops, rr.stops_completed,
            rr.estimated_miles, rr.estimated_duration_minutes,
            rr.total_gallons_delivered, rr.total_revenue,
            rr.estimated_fuel_cost, rr.estimated_driver_cost, rr.estimated_total_cost,
            dc.name as dc_name, dc.code as dc_code,
            d.name as driver_name, d.code as driver_code,
            t.name as truck_name, t.code as truck_code
        FROM route_runs rr
        LEFT JOIN distribution_centers dc ON rr.dc_id = dc.id
        LEFT JOIN drivers d ON rr.driver_id = d.id
        LEFT JOIN trucks t ON rr.truck_id = t.id
        WHERE rr.company_id = $1 
        AND rr.scheduled_date BETWEEN $2 AND $3
        ${dcFilter}
        ORDER BY rr.scheduled_date DESC
    `, params);

    const byStatus = await query(`
        SELECT status, COUNT(*) as count, COALESCE(SUM(estimated_miles), 0) as total_miles, COALESCE(SUM(total_revenue), 0) as total_revenue
        FROM route_runs rr WHERE rr.company_id = $1 AND rr.scheduled_date BETWEEN $2 AND $3 ${dcFilter} GROUP BY status
    `, params);

    const byDC = await query(`
        SELECT dc.id, dc.name, dc.code, COUNT(*) as route_count,
            COALESCE(SUM(rr.stops_completed), 0) as total_deliveries,
            COALESCE(SUM(rr.estimated_miles), 0) as total_miles,
            COALESCE(SUM(rr.total_gallons_delivered), 0) as total_gallons,
            COALESCE(SUM(rr.total_revenue), 0) as total_revenue
        FROM distribution_centers dc
        LEFT JOIN route_runs rr ON dc.id = rr.dc_id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE dc.company_id = $1 GROUP BY dc.id, dc.name, dc.code ORDER BY total_revenue DESC
    `, [companyId, startDate, endDate]);

    const avgMetrics = await query(`
        SELECT COALESCE(AVG(estimated_miles), 0) as avg_miles, COALESCE(AVG(total_stops), 0) as avg_stops,
            COALESCE(AVG(estimated_duration_minutes), 0) as avg_duration, COALESCE(AVG(total_gallons_delivered), 0) as avg_gallons,
            COALESCE(AVG(total_revenue), 0) as avg_revenue, COALESCE(AVG(estimated_total_cost), 0) as avg_cost
        FROM route_runs rr WHERE rr.company_id = $1 AND rr.scheduled_date BETWEEN $2 AND $3 AND rr.status = 'completed' ${dcFilter}
    `, params);

    return success({
        period: { start_date: startDate, end_date: endDate },
        routes: routes.rows,
        summary_by_status: byStatus.rows,
        summary_by_dc: byDC.rows,
        averages: avgMetrics.rows[0],
        total_routes: routes.rows.length
    });
}

// =====================================================
// DRIVER PERFORMANCE REPORT
// =====================================================
async function getDriverReport(companyId, startDate, endDate, user) {
    let dcFilter = '';
    const params = [companyId, startDate, endDate];
    if (user.dcId) {
        dcFilter = ' AND d.dc_id = $4';
        params.push(user.dcId);
    }

    const drivers = await query(`
        SELECT 
            d.id, d.code, d.name, d.phone, d.hire_date, d.cdl_class, d.hazmat_certified,
            dc.name as dc_name,
            COUNT(DISTINCT rr.id) as routes_assigned,
            COUNT(DISTINCT rr.id) FILTER (WHERE rr.status = 'completed') as routes_completed,
            COALESCE(SUM(rr.total_stops), 0) as total_stops,
            COALESCE(SUM(rr.stops_completed), 0) as stops_completed,
            COALESCE(SUM(rr.estimated_miles), 0) as total_miles,
            COALESCE(SUM(rr.estimated_driver_hours), 0) as total_hours,
            COALESCE(SUM(rr.total_gallons_delivered), 0) as total_gallons,
            COALESCE(SUM(rr.total_revenue), 0) as total_revenue,
            COALESCE(SUM(rr.estimated_driver_cost), 0) as total_labor_cost,
            CASE WHEN SUM(rr.stops_completed) > 0 AND SUM(rr.total_stops) > 0
                 THEN ROUND((SUM(rr.stops_completed)::numeric / SUM(rr.total_stops)) * 100, 1) ELSE 0 END as delivery_rate,
            CASE WHEN SUM(rr.estimated_driver_hours) > 0
                 THEN ROUND(SUM(rr.stops_completed)::numeric / SUM(rr.estimated_driver_hours), 1) ELSE 0 END as stops_per_hour,
            CASE WHEN SUM(rr.estimated_driver_hours) > 0
                 THEN ROUND(SUM(rr.estimated_miles)::numeric / SUM(rr.estimated_driver_hours), 1) ELSE 0 END as miles_per_hour
        FROM drivers d
        LEFT JOIN distribution_centers dc ON d.dc_id = dc.id
        LEFT JOIN route_runs rr ON d.id = rr.driver_id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE d.company_id = $1 AND d.status = 'active' ${dcFilter}
        GROUP BY d.id, d.code, d.name, d.phone, d.hire_date, d.cdl_class, d.hazmat_certified, dc.name
        ORDER BY total_revenue DESC
    `, params);

    // Get items delivered per driver
    const driverItems = await query(`
        SELECT 
            d.id as driver_id,
            COALESCE(SUM(di.qty_delivered), 0) as items_delivered,
            COALESCE(SUM(di.qty_collected), 0) as items_collected,
            COALESCE(SUM(di.line_total), 0) as product_revenue
        FROM drivers d
        LEFT JOIN route_runs rr ON d.id = rr.driver_id AND rr.scheduled_date BETWEEN $2 AND $3
        LEFT JOIN route_run_stops rrs ON rr.id = rrs.run_id
        LEFT JOIN delivery_items di ON rrs.id = di.route_run_stop_id
        WHERE d.company_id = $1 AND d.status = 'active' ${dcFilter}
        GROUP BY d.id
    `, params);

    const itemsLookup = {};
    driverItems.rows.forEach(r => { 
        itemsLookup[r.driver_id] = {
            items_delivered: parseInt(r.items_delivered) || 0,
            items_collected: parseInt(r.items_collected) || 0,
            product_revenue: parseFloat(r.product_revenue) || 0
        };
    });

    const skipRates = await query(`
        SELECT d.id as driver_id, COUNT(*) FILTER (WHERE rrs.status = 'skipped') as skipped, COUNT(*) as total
        FROM drivers d JOIN route_runs rr ON d.id = rr.driver_id JOIN route_run_stops rrs ON rr.id = rrs.run_id
        WHERE d.company_id = $1 AND rr.scheduled_date BETWEEN $2 AND $3 GROUP BY d.id
    `, [companyId, startDate, endDate]);

    const skipLookup = {};
    skipRates.rows.forEach(r => { skipLookup[r.driver_id] = r.total > 0 ? ((r.skipped / r.total) * 100).toFixed(1) : 0; });

    const driversWithExtras = drivers.rows.map(d => ({ 
        ...d, 
        skip_rate: skipLookup[d.id] || 0,
        items_delivered: itemsLookup[d.id]?.items_delivered || 0,
        items_collected: itemsLookup[d.id]?.items_collected || 0,
        product_revenue: itemsLookup[d.id]?.product_revenue || 0
    }));

    const teamTotals = await query(`
        SELECT COUNT(DISTINCT d.id) as total_drivers,
            COALESCE(SUM(rr.stops_completed), 0) as team_deliveries,
            COALESCE(SUM(rr.estimated_miles), 0) as team_miles,
            COALESCE(SUM(rr.estimated_driver_hours), 0) as team_hours,
            COALESCE(SUM(rr.total_revenue), 0) as team_revenue,
            COALESCE(SUM(rr.estimated_driver_cost), 0) as team_labor_cost
        FROM drivers d LEFT JOIN route_runs rr ON d.id = rr.driver_id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE d.company_id = $1 AND d.status = 'active' ${dcFilter}
    `, params);

    // Team items totals
    const teamItems = await query(`
        SELECT 
            COALESCE(SUM(di.qty_delivered), 0) as team_items_delivered,
            COALESCE(SUM(di.qty_collected), 0) as team_items_collected
        FROM drivers d
        LEFT JOIN route_runs rr ON d.id = rr.driver_id AND rr.scheduled_date BETWEEN $2 AND $3
        LEFT JOIN route_run_stops rrs ON rr.id = rrs.run_id
        LEFT JOIN delivery_items di ON rrs.id = di.route_run_stop_id
        WHERE d.company_id = $1 AND d.status = 'active' ${dcFilter}
    `, params);

    return success({
        period: { start_date: startDate, end_date: endDate },
        drivers: driversWithExtras,
        team_totals: {
            ...teamTotals.rows[0],
            team_items_delivered: parseInt(teamItems.rows[0]?.team_items_delivered) || 0,
            team_items_collected: parseInt(teamItems.rows[0]?.team_items_collected) || 0
        },
        total_drivers: driversWithExtras.length
    });
}

// =====================================================
// TRUCK/FLEET REPORT
// =====================================================
async function getTruckReport(companyId, startDate, endDate, user) {
    let dcFilter = '';
    const params = [companyId, startDate, endDate];
    if (user.dcId) {
        dcFilter = ' AND t.dc_id = $4';
        params.push(user.dcId);
    }

    const trucks = await query(`
        SELECT 
            t.id, t.code, t.name, t.make, t.model, t.year,
            t.capacity_gallons, t.license_plate, t.status, t.avg_mpg, t.current_odometer,
            dc.name as dc_name, d.name as assigned_driver,
            COUNT(DISTINCT rr.id) as routes_assigned,
            COUNT(DISTINCT rr.id) FILTER (WHERE rr.status = 'completed') as routes_completed,
            COALESCE(SUM(rr.estimated_miles), 0) as total_miles,
            COALESCE(SUM(rr.estimated_fuel_gallons), 0) as total_fuel_used,
            COALESCE(SUM(rr.estimated_fuel_cost), 0) as total_fuel_cost,
            COALESCE(SUM(rr.total_gallons_delivered), 0) as total_product_delivered,
            COALESCE(SUM(rr.stops_completed), 0) as total_deliveries,
            CASE WHEN SUM(rr.estimated_fuel_gallons) > 0
                 THEN ROUND(SUM(rr.estimated_miles)::numeric / SUM(rr.estimated_fuel_gallons), 1) ELSE t.avg_mpg END as actual_mpg,
            CASE WHEN SUM(rr.estimated_miles) > 0
                 THEN ROUND(SUM(rr.estimated_fuel_cost)::numeric / SUM(rr.estimated_miles), 2) ELSE 0 END as cost_per_mile
        FROM trucks t
        LEFT JOIN distribution_centers dc ON t.dc_id = dc.id
        LEFT JOIN drivers d ON t.assigned_driver_id = d.id
        LEFT JOIN route_runs rr ON t.id = rr.truck_id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE t.company_id = $1 ${dcFilter}
        GROUP BY t.id, t.code, t.name, t.make, t.model, t.year, t.capacity_gallons, t.license_plate, t.status, t.avg_mpg, t.current_odometer, dc.name, d.name
        ORDER BY total_miles DESC
    `, params);

    const fleetSummary = await query(`
        SELECT COUNT(DISTINCT t.id) as total_trucks,
            COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'active') as active_trucks,
            COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'maintenance') as in_maintenance,
            COUNT(DISTINCT rr.truck_id) as trucks_used,
            COALESCE(SUM(t.capacity_gallons), 0) as total_fleet_capacity,
            COALESCE(SUM(rr.estimated_miles), 0) as total_fleet_miles,
            COALESCE(SUM(rr.estimated_fuel_gallons), 0) as total_fleet_fuel,
            COALESCE(SUM(rr.estimated_fuel_cost), 0) as total_fleet_fuel_cost,
            COALESCE(AVG(t.avg_mpg), 0) as avg_fleet_mpg
        FROM trucks t LEFT JOIN route_runs rr ON t.id = rr.truck_id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE t.company_id = $1 ${dcFilter}
    `, params);

    const fuelByTruck = trucks.rows.filter(t => parseFloat(t.total_fuel_used) > 0).map(t => ({
        truck: t.code, miles: parseFloat(t.total_miles), fuel: parseFloat(t.total_fuel_used),
        mpg: parseFloat(t.actual_mpg), cost: parseFloat(t.total_fuel_cost)
    }));

    return success({
        period: { start_date: startDate, end_date: endDate },
        trucks: trucks.rows,
        fleet_summary: fleetSummary.rows[0],
        fuel_efficiency: fuelByTruck,
        total_trucks: trucks.rows.length
    });
}

// =====================================================
// CUSTOMER DELIVERY REPORT
// =====================================================
async function getCustomerReport(companyId, startDate, endDate, user) {
    let dcFilter = '';
    const params = [companyId, startDate, endDate];
    if (user.dcId) {
        dcFilter = ' AND c.preferred_dc_id = $4';
        params.push(user.dcId);
    }

    // Customer delivery data with account info
    const customers = await query(`
        SELECT 
            c.id, c.code, c.name, c.address, c.city, c.state,
            c.tank_size, c.current_level, c.price_per_gallon, c.auto_delivery, c.customer_type,
            c.account_balance, c.credit_limit, c.payment_terms,
            c.last_delivery_date, c.last_payment_date, c.last_payment_amount,
            dc.name as dc_name,
            COUNT(DISTINCT rrs.id) as total_deliveries,
            COUNT(DISTINCT rrs.id) FILTER (WHERE rrs.status = 'completed') as completed_deliveries,
            COUNT(DISTINCT rrs.id) FILTER (WHERE rrs.status = 'skipped') as skipped_deliveries,
            COALESCE(SUM(rrs.gallons_delivered), 0) as total_gallons,
            COALESCE(SUM(rrs.delivery_total), 0) as total_spent,
            COALESCE(AVG(rrs.gallons_delivered) FILTER (WHERE rrs.gallons_delivered > 0), 0) as avg_gallons_per_delivery,
            MAX(rr.scheduled_date) as last_delivery_in_period
        FROM customers c
        LEFT JOIN distribution_centers dc ON c.preferred_dc_id = dc.id
        LEFT JOIN route_run_stops rrs ON c.id = rrs.customer_id
        LEFT JOIN route_runs rr ON rrs.run_id = rr.id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE c.company_id = $1 AND c.status = 'active' ${dcFilter}
        GROUP BY c.id, c.code, c.name, c.address, c.city, c.state, c.tank_size, c.current_level, 
                 c.price_per_gallon, c.auto_delivery, c.customer_type, c.account_balance, 
                 c.credit_limit, c.payment_terms, c.last_delivery_date, c.last_payment_date, 
                 c.last_payment_amount, dc.name
        ORDER BY total_spent DESC
    `, params);

    // Product delivery by customer
    const customerProducts = await query(`
        SELECT 
            c.id as customer_id, c.code as customer_code, c.name as customer_name,
            p.id as product_id, p.name as product_name, p.code as product_code,
            COALESCE(SUM(di.qty_delivered), 0) as qty_delivered,
            COALESCE(SUM(di.qty_collected), 0) as qty_collected,
            COALESCE(SUM(di.line_total), 0) as revenue,
            COALESCE(SUM(di.deposit_collected - di.deposit_refunded), 0) as net_deposits
        FROM customers c
        JOIN route_run_stops rrs ON c.id = rrs.customer_id
        JOIN route_runs rr ON rrs.run_id = rr.id AND rr.scheduled_date BETWEEN $2 AND $3
        JOIN delivery_items di ON rrs.id = di.route_run_stop_id
        JOIN products p ON di.product_id = p.id
        WHERE c.company_id = $1 AND c.status = 'active' ${dcFilter}
        GROUP BY c.id, c.code, c.name, p.id, p.name, p.code
        ORDER BY revenue DESC
        LIMIT 100
    `, params);

    const byType = await query(`
        SELECT c.customer_type, COUNT(DISTINCT c.id) as customer_count,
            COALESCE(SUM(rrs.gallons_delivered), 0) as total_gallons,
            COALESCE(SUM(rrs.delivery_total), 0) as total_revenue,
            COALESCE(SUM(c.account_balance), 0) as total_balance
        FROM customers c
        LEFT JOIN route_run_stops rrs ON c.id = rrs.customer_id
        LEFT JOIN route_runs rr ON rrs.run_id = rr.id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE c.company_id = $1 AND c.status = 'active' ${dcFilter}
        GROUP BY c.customer_type
    `, params);

    const lowTank = await query(`
        SELECT c.id, c.code, c.name, c.address, c.city, c.tank_size, c.current_level,
            ROUND((c.tank_size * (1 - c.current_level / 100.0))) as gallons_needed,
            c.account_balance
        FROM customers c WHERE c.company_id = $1 AND c.status = 'active' AND c.current_level <= 30 ${dcFilter}
        ORDER BY c.current_level ASC LIMIT 20
    `, params);

    // Customers with outstanding balances
    const outstandingBalances = await query(`
        SELECT c.id, c.code, c.name, c.account_balance, c.credit_limit, c.payment_terms,
            c.last_payment_date, c.last_delivery_date,
            CASE WHEN c.credit_limit > 0 AND c.account_balance > c.credit_limit THEN true ELSE false END as over_limit
        FROM customers c
        WHERE c.company_id = $1 AND c.status = 'active' AND c.account_balance > 0 ${dcFilter}
        ORDER BY c.account_balance DESC
        LIMIT 20
    `, params);

    const summary = await query(`
        SELECT COUNT(DISTINCT c.id) as total_customers,
            COUNT(DISTINCT c.id) FILTER (WHERE c.auto_delivery = true) as auto_delivery_customers,
            COALESCE(SUM(rrs.gallons_delivered), 0) as total_gallons_delivered,
            COALESCE(SUM(rrs.delivery_total), 0) as total_revenue,
            COUNT(DISTINCT rrs.id) as total_deliveries,
            COALESCE(SUM(c.account_balance), 0) as total_outstanding,
            COUNT(DISTINCT c.id) FILTER (WHERE c.account_balance > 0) as customers_with_balance
        FROM customers c
        LEFT JOIN route_run_stops rrs ON c.id = rrs.customer_id
        LEFT JOIN route_runs rr ON rrs.run_id = rr.id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE c.company_id = $1 AND c.status = 'active' ${dcFilter}
    `, params);

    return success({
        period: { start_date: startDate, end_date: endDate },
        customers: customers.rows.slice(0, 100),
        customer_products: customerProducts.rows,
        by_customer_type: byType.rows,
        low_tank_alerts: lowTank.rows,
        outstanding_balances: outstandingBalances.rows,
        summary: summary.rows[0],
        total_customers: customers.rows.length
    });
}

// =====================================================
// FINANCIAL REPORT
// =====================================================
async function getFinancialReport(companyId, startDate, endDate, user) {
    let dcFilter = '';
    const params = [companyId, startDate, endDate];
    if (user.dcId) {
        dcFilter = ' AND rr.dc_id = $4';
        params.push(user.dcId);
    }

    const financial = await query(`
        SELECT COALESCE(SUM(total_revenue), 0) as total_revenue, COALESCE(SUM(estimated_fuel_cost), 0) as fuel_cost,
            COALESCE(SUM(estimated_driver_cost), 0) as labor_cost, COALESCE(SUM(estimated_total_cost), 0) as total_cost,
            COALESCE(SUM(total_gallons_delivered), 0) as total_gallons, COALESCE(SUM(estimated_miles), 0) as total_miles,
            COUNT(*) as total_routes, COUNT(*) FILTER (WHERE status = 'completed') as completed_routes
        FROM route_runs rr WHERE rr.company_id = $1 AND rr.scheduled_date BETWEEN $2 AND $3 ${dcFilter}
    `, params);

    // Product revenue breakdown
    const productRevenue = await query(`
        SELECT 
            p.id, p.name, p.code, p.category,
            COALESCE(SUM(di.qty_delivered), 0) as qty_sold,
            COALESCE(SUM(di.qty_collected), 0) as qty_collected,
            COALESCE(SUM(di.line_total), 0) as revenue,
            COALESCE(SUM(di.deposit_collected), 0) as deposits_collected,
            COALESCE(SUM(di.deposit_refunded), 0) as deposits_refunded
        FROM products p
        LEFT JOIN delivery_items di ON p.id = di.product_id
        LEFT JOIN route_run_stops rrs ON di.route_run_stop_id = rrs.id
        LEFT JOIN route_runs rr ON rrs.run_id = rr.id 
            AND rr.scheduled_date BETWEEN $2 AND $3
            ${dcFilter}
        WHERE p.company_id = $1 AND p.status = 'active'
        GROUP BY p.id, p.name, p.code, p.category
        ORDER BY revenue DESC
    `, params);

    // Revenue by category
    const byCategory = await query(`
        SELECT 
            COALESCE(p.category, 'Uncategorized') as category,
            COALESCE(SUM(di.qty_delivered), 0) as qty_sold,
            COALESCE(SUM(di.line_total), 0) as revenue
        FROM products p
        LEFT JOIN delivery_items di ON p.id = di.product_id
        LEFT JOIN route_run_stops rrs ON di.route_run_stop_id = rrs.id
        LEFT JOIN route_runs rr ON rrs.run_id = rr.id 
            AND rr.scheduled_date BETWEEN $2 AND $3
            ${dcFilter}
        WHERE p.company_id = $1 AND p.status = 'active'
        GROUP BY p.category
        ORDER BY revenue DESC
    `, params);

    // Customer transactions (payments received)
    const paymentsReceived = await query(`
        SELECT 
            COALESCE(SUM(ABS(amount)), 0) as total_payments,
            COUNT(*) as payment_count
        FROM customer_transactions
        WHERE company_id = $1 
        AND transaction_type = 'payment'
        AND transaction_date BETWEEN $2 AND $3
    `, [companyId, startDate, endDate]);

    // Accounts receivable summary
    const arSummary = await query(`
        SELECT 
            COALESCE(SUM(account_balance), 0) as total_outstanding,
            COUNT(*) FILTER (WHERE account_balance > 0) as customers_with_balance,
            COALESCE(SUM(account_balance) FILTER (WHERE payment_terms = 'cod'), 0) as cod_outstanding,
            COALESCE(SUM(account_balance) FILTER (WHERE payment_terms = 'net15'), 0) as net15_outstanding,
            COALESCE(SUM(account_balance) FILTER (WHERE payment_terms = 'net30'), 0) as net30_outstanding,
            COALESCE(SUM(account_balance) FILTER (WHERE payment_terms = 'net60'), 0) as net60_outstanding
        FROM customers
        WHERE company_id = $1 AND status = 'active'
    `, [companyId]);

    const dailyRevenue = await query(`
        SELECT rr.scheduled_date::date as date, COALESCE(SUM(total_revenue), 0) as revenue,
            COALESCE(SUM(estimated_total_cost), 0) as cost, COALESCE(SUM(total_gallons_delivered), 0) as gallons
        FROM route_runs rr WHERE rr.company_id = $1 AND rr.scheduled_date BETWEEN $2 AND $3 ${dcFilter}
        GROUP BY rr.scheduled_date::date ORDER BY date
    `, params);

    const byDC = await query(`
        SELECT dc.id, dc.name, dc.code, COALESCE(SUM(rr.total_revenue), 0) as revenue,
            COALESCE(SUM(rr.estimated_total_cost), 0) as cost, COALESCE(SUM(rr.total_gallons_delivered), 0) as gallons
        FROM distribution_centers dc LEFT JOIN route_runs rr ON dc.id = rr.dc_id AND rr.scheduled_date BETWEEN $2 AND $3
        WHERE dc.company_id = $1 GROUP BY dc.id, dc.name, dc.code ORDER BY revenue DESC
    `, [companyId, startDate, endDate]);

    const fin = financial.rows[0];
    const payments = paymentsReceived.rows[0] || {};
    const ar = arSummary.rows[0] || {};
    const revenue = parseFloat(fin.total_revenue) || 0;
    const cost = parseFloat(fin.total_cost) || 0;
    const gallons = parseFloat(fin.total_gallons) || 0;
    const miles = parseFloat(fin.total_miles) || 0;

    return success({
        period: { start_date: startDate, end_date: endDate },
        summary: {
            total_revenue: revenue, total_cost: cost, gross_profit: revenue - cost,
            profit_margin: revenue > 0 ? (((revenue - cost) / revenue) * 100).toFixed(1) : 0,
            fuel_cost: parseFloat(fin.fuel_cost) || 0, labor_cost: parseFloat(fin.labor_cost) || 0,
            revenue_per_gallon: gallons > 0 ? (revenue / gallons).toFixed(2) : 0,
            cost_per_gallon: gallons > 0 ? (cost / gallons).toFixed(2) : 0,
            revenue_per_mile: miles > 0 ? (revenue / miles).toFixed(2) : 0,
            cost_per_mile: miles > 0 ? (cost / miles).toFixed(2) : 0,
            total_gallons: gallons, total_miles: miles
        },
        cost_breakdown: {
            fuel: parseFloat(fin.fuel_cost) || 0, fuel_percentage: cost > 0 ? ((fin.fuel_cost / cost) * 100).toFixed(1) : 0,
            labor: parseFloat(fin.labor_cost) || 0, labor_percentage: cost > 0 ? ((fin.labor_cost / cost) * 100).toFixed(1) : 0
        },
        product_revenue: productRevenue.rows,
        revenue_by_category: byCategory.rows,
        payments: {
            total_received: parseFloat(payments.total_payments) || 0,
            payment_count: parseInt(payments.payment_count) || 0
        },
        accounts_receivable: {
            total_outstanding: parseFloat(ar.total_outstanding) || 0,
            customers_with_balance: parseInt(ar.customers_with_balance) || 0,
            by_terms: {
                cod: parseFloat(ar.cod_outstanding) || 0,
                net15: parseFloat(ar.net15_outstanding) || 0,
                net30: parseFloat(ar.net30_outstanding) || 0,
                net60: parseFloat(ar.net60_outstanding) || 0
            }
        },
        daily_trend: dailyRevenue.rows,
        by_distribution_center: byDC.rows
    });
}

// =====================================================
// DAILY SUMMARY REPORT
// =====================================================
async function getDailyReport(companyId, startDate, endDate, user) {
    let dcFilter = '';
    const params = [companyId, startDate, endDate];
    if (user.dcId) {
        dcFilter = ' AND rr.dc_id = $4';
        params.push(user.dcId);
    }

    const daily = await query(`
        SELECT rr.scheduled_date::date as date, COUNT(DISTINCT rr.id) as routes,
            COUNT(DISTINCT rr.id) FILTER (WHERE rr.status = 'completed') as completed_routes,
            COUNT(DISTINCT rr.driver_id) as drivers_active, COUNT(DISTINCT rr.truck_id) as trucks_used,
            COALESCE(SUM(rr.total_stops), 0) as total_stops, COALESCE(SUM(rr.stops_completed), 0) as stops_completed,
            COALESCE(SUM(rr.estimated_miles), 0) as total_miles, COALESCE(SUM(rr.total_gallons_delivered), 0) as total_gallons,
            COALESCE(SUM(rr.total_revenue), 0) as total_revenue, COALESCE(SUM(rr.estimated_total_cost), 0) as total_cost,
            COALESCE(SUM(rr.estimated_fuel_cost), 0) as fuel_cost, COALESCE(SUM(rr.estimated_driver_cost), 0) as labor_cost
        FROM route_runs rr WHERE rr.company_id = $1 AND rr.scheduled_date BETWEEN $2 AND $3 ${dcFilter}
        GROUP BY rr.scheduled_date::date ORDER BY date DESC
    `, params);

    // Daily product items delivered
    const dailyItems = await query(`
        SELECT rr.scheduled_date::date as date,
            COALESCE(SUM(di.qty_delivered), 0) as items_delivered,
            COALESCE(SUM(di.qty_collected), 0) as items_collected,
            COALESCE(SUM(di.line_total), 0) as product_revenue
        FROM route_runs rr
        JOIN route_run_stops rrs ON rr.id = rrs.run_id
        JOIN delivery_items di ON rrs.id = di.route_run_stop_id
        WHERE rr.company_id = $1 AND rr.scheduled_date BETWEEN $2 AND $3 ${dcFilter}
        GROUP BY rr.scheduled_date::date
    `, params);

    // Merge daily items into daily data
    const itemsLookup = {};
    dailyItems.rows.forEach(r => { 
        itemsLookup[r.date] = {
            items_delivered: parseInt(r.items_delivered) || 0,
            items_collected: parseInt(r.items_collected) || 0,
            product_revenue: parseFloat(r.product_revenue) || 0
        };
    });

    const dailyWithItems = daily.rows.map(d => ({
        ...d,
        items_delivered: itemsLookup[d.date]?.items_delivered || 0,
        items_collected: itemsLookup[d.date]?.items_collected || 0,
        product_revenue: itemsLookup[d.date]?.product_revenue || 0
    }));

    const totals = dailyWithItems.reduce((acc, day) => ({
        routes: acc.routes + parseInt(day.routes), completed_routes: acc.completed_routes + parseInt(day.completed_routes),
        stops_completed: acc.stops_completed + parseInt(day.stops_completed),
        total_miles: acc.total_miles + parseFloat(day.total_miles), total_gallons: acc.total_gallons + parseFloat(day.total_gallons),
        total_revenue: acc.total_revenue + parseFloat(day.total_revenue), total_cost: acc.total_cost + parseFloat(day.total_cost),
        items_delivered: acc.items_delivered + (day.items_delivered || 0),
        items_collected: acc.items_collected + (day.items_collected || 0)
    }), { routes: 0, completed_routes: 0, stops_completed: 0, total_miles: 0, total_gallons: 0, total_revenue: 0, total_cost: 0, items_delivered: 0, items_collected: 0 });

    return success({
        period: { start_date: startDate, end_date: endDate },
        daily: dailyWithItems,
        totals: totals,
        days_count: daily.rows.length,
        averages: {
            routes_per_day: daily.rows.length > 0 ? (totals.routes / daily.rows.length).toFixed(1) : 0,
            stops_per_day: daily.rows.length > 0 ? (totals.stops_completed / daily.rows.length).toFixed(1) : 0,
            miles_per_day: daily.rows.length > 0 ? (totals.total_miles / daily.rows.length).toFixed(1) : 0,
            gallons_per_day: daily.rows.length > 0 ? (totals.total_gallons / daily.rows.length).toFixed(1) : 0,
            revenue_per_day: daily.rows.length > 0 ? (totals.total_revenue / daily.rows.length).toFixed(2) : 0,
            items_per_day: daily.rows.length > 0 ? (totals.items_delivered / daily.rows.length).toFixed(1) : 0
        }
    });
}

// =====================================================
// PRODUCTS SALES REPORT
// =====================================================
async function getProductsReport(companyId, startDate, endDate, user) {
    let dcFilter = '';
    const params = [companyId, startDate, endDate];
    if (user.dcId) {
        dcFilter = ' AND rr.dc_id = $4';
        params.push(user.dcId);
    }

    // Product sales summary
    const products = await query(`
        SELECT 
            p.id, p.code, p.name, p.category, p.unit_type, p.price, p.deposit_amount,
            p.is_exchangeable, p.track_inventory,
            COALESCE(SUM(di.qty_delivered), 0) as qty_sold,
            COALESCE(SUM(di.qty_collected), 0) as qty_collected,
            COALESCE(SUM(di.line_total), 0) as revenue,
            COALESCE(SUM(di.deposit_collected), 0) as deposits_collected,
            COALESCE(SUM(di.deposit_refunded), 0) as deposits_refunded,
            COUNT(DISTINCT rrs.customer_id) as unique_customers,
            COUNT(DISTINCT rrs.id) as delivery_count,
            COALESCE(AVG(di.qty_delivered), 0) as avg_qty_per_delivery
        FROM products p
        LEFT JOIN delivery_items di ON p.id = di.product_id
        LEFT JOIN route_run_stops rrs ON di.route_run_stop_id = rrs.id
        LEFT JOIN route_runs rr ON rrs.run_id = rr.id 
            AND rr.scheduled_date BETWEEN $2 AND $3
            ${dcFilter}
        WHERE p.company_id = $1 AND p.status = 'active'
        GROUP BY p.id, p.code, p.name, p.category, p.unit_type, p.price, p.deposit_amount, p.is_exchangeable, p.track_inventory
        ORDER BY revenue DESC
    `, params);

    // Sales by category
    const byCategory = await query(`
        SELECT 
            COALESCE(p.category, 'Uncategorized') as category,
            COUNT(DISTINCT p.id) as product_count,
            COALESCE(SUM(di.qty_delivered), 0) as qty_sold,
            COALESCE(SUM(di.qty_collected), 0) as qty_collected,
            COALESCE(SUM(di.line_total), 0) as revenue,
            COUNT(DISTINCT rrs.customer_id) as unique_customers
        FROM products p
        LEFT JOIN delivery_items di ON p.id = di.product_id
        LEFT JOIN route_run_stops rrs ON di.route_run_stop_id = rrs.id
        LEFT JOIN route_runs rr ON rrs.run_id = rr.id 
            AND rr.scheduled_date BETWEEN $2 AND $3
            ${dcFilter}
        WHERE p.company_id = $1 AND p.status = 'active'
        GROUP BY p.category
        ORDER BY revenue DESC
    `, params);

    // Daily product sales trend
    const dailyTrend = await query(`
        SELECT 
            rr.scheduled_date::date as date,
            COALESCE(SUM(di.qty_delivered), 0) as qty_sold,
            COALESCE(SUM(di.line_total), 0) as revenue
        FROM delivery_items di
        JOIN route_run_stops rrs ON di.route_run_stop_id = rrs.id
        JOIN route_runs rr ON rrs.run_id = rr.id
        WHERE rr.company_id = $1 
        AND rr.scheduled_date BETWEEN $2 AND $3
        ${dcFilter}
        GROUP BY rr.scheduled_date::date
        ORDER BY date DESC
        LIMIT 30
    `, params);

    // Top selling products by customer
    const topByCustomer = await query(`
        SELECT 
            c.id as customer_id, c.code as customer_code, c.name as customer_name,
            p.id as product_id, p.name as product_name,
            COALESCE(SUM(di.qty_delivered), 0) as qty_purchased,
            COALESCE(SUM(di.line_total), 0) as total_spent
        FROM customers c
        JOIN route_run_stops rrs ON c.id = rrs.customer_id
        JOIN route_runs rr ON rrs.run_id = rr.id AND rr.scheduled_date BETWEEN $2 AND $3
        JOIN delivery_items di ON rrs.id = di.route_run_stop_id
        JOIN products p ON di.product_id = p.id
        WHERE c.company_id = $1 ${dcFilter}
        GROUP BY c.id, c.code, c.name, p.id, p.name
        ORDER BY total_spent DESC
        LIMIT 50
    `, params);

    // Inventory status (current stock levels)
    const inventory = await query(`
        SELECT 
            p.id, p.code, p.name, p.category,
            COALESCE(ti.quantity, 0) as current_stock,
            COALESCE(ti.min_quantity, 0) as min_quantity,
            CASE WHEN ti.quantity < ti.min_quantity THEN true ELSE false END as low_stock
        FROM products p
        LEFT JOIN truck_inventory ti ON p.id = ti.product_id
        WHERE p.company_id = $1 AND p.status = 'active' AND p.track_inventory = true
        ORDER BY p.name
    `, [companyId]);

    // Customer assignments (how many customers have each product assigned)
    const customerAssignments = await query(`
        SELECT 
            p.id, p.name, p.code,
            COUNT(DISTINCT cp.customer_id) as assigned_customers
        FROM products p
        LEFT JOIN customer_products cp ON p.id = cp.product_id
        WHERE p.company_id = $1 AND p.status = 'active'
        GROUP BY p.id, p.name, p.code
        ORDER BY assigned_customers DESC
    `, [companyId]);

    // Summary totals
    const summary = products.rows.reduce((acc, p) => ({
        total_products: acc.total_products + 1,
        total_qty_sold: acc.total_qty_sold + parseInt(p.qty_sold),
        total_qty_collected: acc.total_qty_collected + parseInt(p.qty_collected),
        total_revenue: acc.total_revenue + parseFloat(p.revenue),
        total_deposits_collected: acc.total_deposits_collected + parseFloat(p.deposits_collected),
        total_deposits_refunded: acc.total_deposits_refunded + parseFloat(p.deposits_refunded),
        unique_customers: Math.max(acc.unique_customers, parseInt(p.unique_customers) || 0)
    }), { total_products: 0, total_qty_sold: 0, total_qty_collected: 0, total_revenue: 0, total_deposits_collected: 0, total_deposits_refunded: 0, unique_customers: 0 });

    return success({
        period: { start_date: startDate, end_date: endDate },
        products: products.rows,
        by_category: byCategory.rows,
        daily_trend: dailyTrend.rows,
        top_by_customer: topByCustomer.rows,
        inventory_status: inventory.rows,
        customer_assignments: customerAssignments.rows,
        summary: {
            ...summary,
            net_deposits: summary.total_deposits_collected - summary.total_deposits_refunded,
            avg_revenue_per_product: summary.total_products > 0 ? (summary.total_revenue / summary.total_products).toFixed(2) : 0
        }
    });
}

// =====================================================
// EXPORT REPORT AS CSV
// =====================================================
async function exportReportCSV(companyId, reportType, startDate, endDate, user) {
    let headers, rows, filename;

    switch (reportType) {
        case 'routes': {
            const data = await getRouteReport(companyId, startDate, endDate, user);
            const report = JSON.parse(data.body);
            filename = `routes_${startDate}_to_${endDate}.csv`;
            headers = ['Date', 'Route Name', 'DC', 'Driver', 'Truck', 'Status', 'Stops Completed', 'Total Stops', 'Miles', 'Duration (hrs)', 'Gallons', 'Revenue', 'Fuel Cost', 'Driver Cost', 'Total Cost', 'Profit'];
            rows = report.routes.map(r => [
                r.scheduled_date, r.name || 'Unnamed', r.dc_name || '', r.driver_name || '', r.truck_code || '',
                r.status, r.stops_completed, r.total_stops, 
                parseFloat(r.estimated_miles || 0).toFixed(1),
                (parseFloat(r.estimated_duration_minutes || 0) / 60).toFixed(1),
                parseFloat(r.total_gallons_delivered || 0).toFixed(0),
                parseFloat(r.total_revenue || 0).toFixed(2),
                parseFloat(r.estimated_fuel_cost || 0).toFixed(2),
                parseFloat(r.estimated_driver_cost || 0).toFixed(2),
                parseFloat(r.estimated_total_cost || 0).toFixed(2),
                (parseFloat(r.total_revenue || 0) - parseFloat(r.estimated_total_cost || 0)).toFixed(2)
            ]);
            break;
        }

        case 'drivers': {
            const data = await getDriverReport(companyId, startDate, endDate, user);
            const report = JSON.parse(data.body);
            filename = `drivers_${startDate}_to_${endDate}.csv`;
            headers = ['Code', 'Name', 'DC', 'Phone', 'License Class', 'HAZMAT', 'Routes', 'Stops', 'Miles', 'Hours', 'Gallons', 'Items Delivered', 'Items Collected', 'Revenue', 'Skip Rate'];
            rows = report.drivers.map(d => [
                d.code, d.name, d.dc_name || '', d.phone || '', d.cdl_class || '',
                d.hazmat_certified ? 'Yes' : 'No',
                parseInt(d.routes_completed || 0),
                parseInt(d.stops_completed || 0),
                parseFloat(d.total_miles || 0).toFixed(1),
                parseFloat(d.total_hours || 0).toFixed(1),
                parseFloat(d.total_gallons || 0).toFixed(0),
                parseInt(d.items_delivered || 0),
                parseInt(d.items_collected || 0),
                parseFloat(d.total_revenue || 0).toFixed(2),
                `${d.skip_rate || 0}%`
            ]);
            break;
        }

        case 'trucks': {
            const data = await getTruckReport(companyId, startDate, endDate, user);
            const report = JSON.parse(data.body);
            filename = `trucks_${startDate}_to_${endDate}.csv`;
            headers = ['Code', 'Name', 'Make', 'Model', 'Year', 'DC', 'Status', 'Capacity', 'MPG', 'Odometer', 'Routes', 'Miles', 'Fuel Gallons', 'Fuel Cost', 'Gallons Delivered', 'Revenue'];
            rows = report.trucks.map(t => [
                t.code, t.name || '', t.make || '', t.model || '', t.year || '',
                t.dc_name || '', t.status, t.capacity_gallons || 0, t.avg_mpg || 0,
                t.current_odometer || 0, t.total_routes || 0,
                parseFloat(t.total_miles || 0).toFixed(1),
                parseFloat(t.total_fuel_gallons || 0).toFixed(1),
                parseFloat(t.total_fuel_cost || 0).toFixed(2),
                parseFloat(t.total_gallons_delivered || 0).toFixed(0),
                parseFloat(t.total_revenue || 0).toFixed(2)
            ]);
            break;
        }

        case 'customers': {
            const data = await getCustomerReport(companyId, startDate, endDate, user);
            const report = JSON.parse(data.body);
            filename = `customers_${startDate}_to_${endDate}.csv`;
            headers = ['Code', 'Name', 'Address', 'City', 'State', 'DC', 'Type', 'Payment Terms', 'Account Balance', 'Credit Limit', 'Deliveries', 'Gallons', 'Revenue', 'Last Delivery'];
            rows = report.customers.map(c => [
                c.code, c.name, c.address || '', c.city || '', c.state || '',
                c.dc_name || '', c.customer_type || '', c.payment_terms || '',
                parseFloat(c.account_balance || 0).toFixed(2),
                parseFloat(c.credit_limit || 0).toFixed(2),
                parseInt(c.completed_deliveries || 0),
                parseFloat(c.total_gallons || 0).toFixed(0),
                parseFloat(c.total_spent || 0).toFixed(2),
                c.last_delivery_in_period || c.last_delivery_date || ''
            ]);
            break;
        }

        case 'daily': {
            const data = await getDailyReport(companyId, startDate, endDate, user);
            const report = JSON.parse(data.body);
            filename = `daily_${startDate}_to_${endDate}.csv`;
            headers = ['Date', 'Day', 'Routes', 'Completed', 'Stops', 'Miles', 'Gallons', 'Items Delivered', 'Items Collected', 'Revenue', 'Cost', 'Profit'];
            rows = report.daily.map(d => [
                d.date, new Date(d.date).toLocaleDateString('en-US', { weekday: 'long' }),
                d.routes, d.completed_routes, d.stops_completed,
                parseFloat(d.total_miles || 0).toFixed(1),
                parseFloat(d.total_gallons || 0).toFixed(0),
                parseInt(d.items_delivered || 0),
                parseInt(d.items_collected || 0),
                parseFloat(d.total_revenue || 0).toFixed(2),
                parseFloat(d.total_cost || 0).toFixed(2),
                (parseFloat(d.total_revenue || 0) - parseFloat(d.total_cost || 0)).toFixed(2)
            ]);
            break;
        }

        case 'financial': {
            const data = await getFinancialReport(companyId, startDate, endDate, user);
            const report = JSON.parse(data.body);
            filename = `financial_${startDate}_to_${endDate}.csv`;
            headers = ['Date', 'Revenue', 'Cost', 'Gallons', 'Profit'];
            rows = report.daily_trend.map(d => [
                d.date,
                parseFloat(d.revenue || 0).toFixed(2),
                parseFloat(d.cost || 0).toFixed(2),
                parseFloat(d.gallons || 0).toFixed(0),
                (parseFloat(d.revenue || 0) - parseFloat(d.cost || 0)).toFixed(2)
            ]);
            break;
        }

        case 'products': {
            const data = await getProductsReport(companyId, startDate, endDate, user);
            const report = JSON.parse(data.body);
            filename = `products_${startDate}_to_${endDate}.csv`;
            headers = ['Code', 'Name', 'Category', 'Unit', 'Price', 'Qty Sold', 'Qty Collected', 'Revenue', 'Deposits Collected', 'Deposits Refunded', 'Net Deposits', 'Unique Customers', 'Deliveries'];
            rows = report.products.map(p => [
                p.code, p.name, p.category || '', p.unit_type || '',
                parseFloat(p.price || 0).toFixed(2),
                parseInt(p.qty_sold || 0),
                parseInt(p.qty_collected || 0),
                parseFloat(p.revenue || 0).toFixed(2),
                parseFloat(p.deposits_collected || 0).toFixed(2),
                parseFloat(p.deposits_refunded || 0).toFixed(2),
                (parseFloat(p.deposits_collected || 0) - parseFloat(p.deposits_refunded || 0)).toFixed(2),
                parseInt(p.unique_customers || 0),
                parseInt(p.delivery_count || 0)
            ]);
            break;
        }

        default:
            return error('Unknown report type: ' + reportType, 400);
    }

    // Build CSV content
    const escapeCSV = (val) => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        },
        body: csvContent
    };
}
