// =====================================================
// PREDICTIONS API - Predictive Ordering System
// =====================================================
// Analyzes customer history and seasonal patterns
// to predict future orders and optimize route planning

const { query } = require('./utils/db');
const { success, error, parseBody } = require('./utils/response');
const { authenticateRequest } = require('./utils/auth');

exports.handler = async (event) => {
    try {
        const { user, companyId, role } = await authenticateRequest(event);
        if (!user) return error('Unauthorized', 401);

        const method = event.httpMethod;
        const path = event.path.replace('/.netlify/functions/predictions', '');

        // =====================================================
        // GET /predictions - Get all customer predictions
        // =====================================================
        if (method === 'GET' && (path === '' || path === '/')) {
            const dcId = event.queryStringParameters?.dc_id;
            const recommendation = event.queryStringParameters?.recommendation;
            const minUrgency = event.queryStringParameters?.min_urgency || 0;
            const limit = Math.min(parseInt(event.queryStringParameters?.limit) || 100, 500);

            let whereClause = 'WHERE cp.company_id = $1 AND cp.urgency_score >= $2';
            let params = [companyId, minUrgency];
            let paramIdx = 3;

            if (dcId) {
                whereClause += ` AND c.preferred_dc_id = $${paramIdx}`;
                params.push(dcId);
                paramIdx++;
            }

            if (recommendation) {
                whereClause += ` AND cp.recommendation = $${paramIdx}`;
                params.push(recommendation);
                paramIdx++;
            }

            const result = await query(`
                SELECT 
                    cp.*,
                    c.code as customer_code,
                    c.name as customer_name,
                    c.address,
                    c.city,
                    c.state,
                    c.lat,
                    c.lng,
                    c.phone,
                    c.tank_size,
                    c.tank_percentage,
                    c.preferred_dc_id,
                    dc.name as dc_name,
                    dc.code as dc_code
                FROM customer_predictions cp
                JOIN customers c ON cp.customer_id = c.id
                LEFT JOIN distribution_centers dc ON c.preferred_dc_id = dc.id
                ${whereClause}
                AND c.status = 'active'
                ORDER BY cp.urgency_score DESC, cp.predicted_next_order_date ASC
                LIMIT $${paramIdx}
            `, [...params, limit]);

            // Group by recommendation for summary
            const summary = {
                schedule_now: 0,
                schedule_soon: 0,
                monitor: 0,
                no_action: 0,
                total: result.rows.length
            };
            
            result.rows.forEach(r => {
                if (summary[r.recommendation] !== undefined) {
                    summary[r.recommendation]++;
                }
            });

            return success({
                predictions: result.rows,
                summary
            });
        }

        // =====================================================
        // GET /predictions/customer/:id - Single customer prediction
        // =====================================================
        if (method === 'GET' && path.startsWith('/customer/')) {
            const customerId = path.split('/')[2];
            
            // Get prediction with full history
            const prediction = await query(`
                SELECT 
                    cp.*,
                    c.code as customer_code,
                    c.name as customer_name,
                    c.address,
                    c.city,
                    c.state,
                    c.tank_size,
                    c.tank_percentage
                FROM customer_predictions cp
                JOIN customers c ON cp.customer_id = c.id
                WHERE cp.customer_id = $1 AND cp.company_id = $2
            `, [customerId, companyId]);

            // Get delivery history for chart
            const history = await query(`
                SELECT 
                    rrs.departed_at::DATE as delivery_date,
                    rrs.gallons_delivered,
                    rrs.revenue,
                    EXTRACT(MONTH FROM rrs.departed_at) as month,
                    EXTRACT(YEAR FROM rrs.departed_at) as year
                FROM route_run_stops rrs
                JOIN route_runs rr ON rrs.route_run_id = rr.id
                WHERE rr.company_id = $1
                AND rrs.customer_id = $2
                AND rrs.status = 'completed'
                ORDER BY rrs.departed_at DESC
                LIMIT 24
            `, [companyId, customerId]);

            // Get monthly consumption aggregates
            const monthlyConsumption = await query(`
                SELECT 
                    EXTRACT(YEAR FROM rrs.departed_at) as year,
                    EXTRACT(MONTH FROM rrs.departed_at) as month,
                    SUM(rrs.gallons_delivered) as total_gallons,
                    COUNT(*) as delivery_count,
                    SUM(rrs.revenue) as total_revenue
                FROM route_run_stops rrs
                JOIN route_runs rr ON rrs.route_run_id = rr.id
                WHERE rr.company_id = $1
                AND rrs.customer_id = $2
                AND rrs.status = 'completed'
                AND rrs.departed_at >= NOW() - INTERVAL '2 years'
                GROUP BY EXTRACT(YEAR FROM rrs.departed_at), EXTRACT(MONTH FROM rrs.departed_at)
                ORDER BY year DESC, month DESC
            `, [companyId, customerId]);

            return success({
                prediction: prediction.rows[0] || null,
                deliveryHistory: history.rows,
                monthlyConsumption: monthlyConsumption.rows
            });
        }

        // =====================================================
        // POST /predictions/refresh - Recalculate all predictions
        // =====================================================
        if (method === 'POST' && path === '/refresh') {
            if (role !== 'admin' && role !== 'dispatch') {
                return error('Admin or dispatch access required', 403);
            }

            // Call the database function to update predictions
            const result = await query(
                'SELECT update_customer_predictions($1) as updated_count',
                [companyId]
            );

            return success({
                message: 'Predictions updated',
                customersUpdated: result.rows[0]?.updated_count || 0
            });
        }

        // =====================================================
        // POST /predictions/calculate/:customerId - Single customer
        // =====================================================
        if (method === 'POST' && path.startsWith('/calculate/')) {
            const customerId = path.split('/')[2];
            
            // Calculate consumption for single customer
            const consumption = await calculateCustomerConsumption(companyId, customerId);
            
            // Get seasonal factor
            const currentMonth = new Date().getMonth() + 1;
            const seasonalResult = await query(`
                SELECT COALESCE(factor, 1.0) as factor
                FROM seasonal_factors
                WHERE company_id = $1 AND month = $2 AND product_category IS NULL
                LIMIT 1
            `, [companyId, currentMonth]);
            const seasonalFactor = seasonalResult.rows[0]?.factor || 1.0;

            // Get last delivery
            const lastDelivery = await query(`
                SELECT 
                    rrs.departed_at::DATE as delivery_date,
                    rrs.gallons_delivered
                FROM route_run_stops rrs
                JOIN route_runs rr ON rrs.route_run_id = rr.id
                WHERE rr.company_id = $1 AND rrs.customer_id = $2 AND rrs.status = 'completed'
                ORDER BY rrs.departed_at DESC
                LIMIT 1
            `, [companyId, customerId]);

            const lastDate = lastDelivery.rows[0]?.delivery_date;
            const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate)) / (1000 * 60 * 60 * 24)) : 999;

            // Calculate prediction
            let predictedDate = new Date();
            let urgency = 50;

            if (consumption.deliveryFrequencyDays > 0 && lastDate) {
                const adjustedFrequency = consumption.deliveryFrequencyDays / seasonalFactor;
                predictedDate = new Date(new Date(lastDate).getTime() + adjustedFrequency * 24 * 60 * 60 * 1000);
                urgency = Math.min(100, Math.max(0, Math.round((daysSince / adjustedFrequency) * 100)));
            }

            let recommendation = 'no_action';
            let reason = 'Recently serviced';
            
            if (urgency >= 90) {
                recommendation = 'schedule_now';
                reason = 'Customer is overdue based on historical pattern';
            } else if (urgency >= 70) {
                recommendation = 'schedule_soon';
                reason = `Delivery likely needed within ${Math.ceil((predictedDate - new Date()) / (1000 * 60 * 60 * 24))} days`;
            } else if (urgency >= 40) {
                recommendation = 'monitor';
                reason = 'On track, monitor consumption';
            }

            // Upsert prediction
            await query(`
                INSERT INTO customer_predictions (
                    company_id, customer_id,
                    last_delivery_date, last_delivery_gallons, days_since_delivery,
                    avg_daily_consumption, delivery_frequency_days,
                    current_seasonal_factor, adjusted_daily_consumption,
                    predicted_next_order_date, predicted_quantity,
                    urgency_score, confidence_score,
                    recommendation, recommendation_reason,
                    data_points_used, calculation_date
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
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
                    calculation_date = EXCLUDED.calculation_date
            `, [
                companyId, customerId,
                lastDate, consumption.avgDeliveryGallons, daysSince,
                consumption.avgDailyConsumption, consumption.deliveryFrequencyDays,
                seasonalFactor, consumption.avgDailyConsumption * seasonalFactor,
                predictedDate.toISOString().split('T')[0], consumption.avgDeliveryGallons,
                urgency, consumption.dataQualityScore,
                recommendation, reason,
                consumption.totalDeliveries
            ]);

            // Update customer table
            await query(`
                UPDATE customers SET
                    predicted_next_order = $1,
                    predicted_quantity = $2,
                    urgency_score = $3,
                    avg_consumption_rate = $4,
                    delivery_frequency_days = $5
                WHERE id = $6
            `, [
                predictedDate.toISOString().split('T')[0],
                consumption.avgDeliveryGallons,
                urgency,
                consumption.avgDailyConsumption,
                Math.round(consumption.deliveryFrequencyDays),
                customerId
            ]);

            return success({
                customerId,
                prediction: {
                    lastDeliveryDate: lastDate,
                    daysSinceDelivery: daysSince,
                    avgDailyConsumption: consumption.avgDailyConsumption,
                    deliveryFrequencyDays: consumption.deliveryFrequencyDays,
                    seasonalFactor,
                    predictedNextOrder: predictedDate.toISOString().split('T')[0],
                    predictedQuantity: consumption.avgDeliveryGallons,
                    urgencyScore: urgency,
                    confidenceScore: consumption.dataQualityScore,
                    recommendation,
                    recommendationReason: reason,
                    dataPointsUsed: consumption.totalDeliveries
                }
            });
        }

        // =====================================================
        // GET /predictions/seasonal - Get seasonal factors
        // =====================================================
        if (method === 'GET' && path === '/seasonal') {
            const result = await query(`
                SELECT * FROM seasonal_factors
                WHERE company_id = $1
                ORDER BY product_category NULLS FIRST, month
            `, [companyId]);

            return success({ seasonalFactors: result.rows });
        }

        // =====================================================
        // PUT /predictions/seasonal - Update seasonal factors
        // =====================================================
        if (method === 'PUT' && path === '/seasonal') {
            if (role !== 'admin') {
                return error('Admin access required', 403);
            }

            const body = parseBody(event);
            const { factors } = body; // Array of { month, factor, product_category }

            if (!Array.isArray(factors)) {
                return error('factors array required', 400);
            }

            for (const f of factors) {
                if (f.month < 1 || f.month > 12) continue;
                
                await query(`
                    INSERT INTO seasonal_factors (company_id, month, factor, product_category, notes)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (company_id, month, product_category) DO UPDATE SET
                        factor = EXCLUDED.factor,
                        notes = EXCLUDED.notes,
                        updated_at = NOW()
                `, [companyId, f.month, f.factor, f.product_category || null, f.notes || null]);
            }

            return success({ message: 'Seasonal factors updated' });
        }

        // =====================================================
        // GET /predictions/dashboard - Dashboard summary
        // =====================================================
        if (method === 'GET' && path === '/dashboard') {
            // Get prediction summary by urgency
            const summary = await query(`
                SELECT 
                    recommendation,
                    COUNT(*) as count,
                    AVG(urgency_score) as avg_urgency,
                    AVG(predicted_quantity) as avg_quantity
                FROM customer_predictions
                WHERE company_id = $1
                GROUP BY recommendation
            `, [companyId]);

            // Get urgent customers (top 10)
            const urgent = await query(`
                SELECT 
                    cp.customer_id,
                    c.name as customer_name,
                    c.code as customer_code,
                    c.city,
                    dc.name as dc_name,
                    cp.urgency_score,
                    cp.predicted_next_order_date,
                    cp.predicted_quantity,
                    cp.recommendation,
                    cp.days_since_delivery
                FROM customer_predictions cp
                JOIN customers c ON cp.customer_id = c.id
                LEFT JOIN distribution_centers dc ON c.preferred_dc_id = dc.id
                WHERE cp.company_id = $1 AND cp.urgency_score >= 70
                ORDER BY cp.urgency_score DESC
                LIMIT 10
            `, [companyId]);

            // Get predicted orders for next 7 days
            const upcoming = await query(`
                SELECT 
                    predicted_next_order_date as date,
                    COUNT(*) as predicted_orders,
                    SUM(predicted_quantity) as predicted_gallons
                FROM customer_predictions
                WHERE company_id = $1
                AND predicted_next_order_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
                GROUP BY predicted_next_order_date
                ORDER BY predicted_next_order_date
            `, [companyId]);

            // Get current seasonal factor
            const currentMonth = new Date().getMonth() + 1;
            const seasonal = await query(`
                SELECT month, factor, notes
                FROM seasonal_factors
                WHERE company_id = $1 AND product_category IS NULL
                ORDER BY month
            `, [companyId]);

            return success({
                summary: summary.rows,
                urgentCustomers: urgent.rows,
                upcomingOrders: upcoming.rows,
                seasonalFactors: seasonal.rows,
                currentMonth
            });
        }

        // =====================================================
        // GET /predictions/route-suggestions/:dcId - For route planning
        // =====================================================
        if (method === 'GET' && path.startsWith('/route-suggestions/')) {
            const dcId = path.split('/')[2];
            const maxCustomers = parseInt(event.queryStringParameters?.limit) || 50;
            const minUrgency = parseInt(event.queryStringParameters?.min_urgency) || 50;

            const suggestions = await query(`
                SELECT 
                    c.id,
                    c.code,
                    c.name,
                    c.address,
                    c.city,
                    c.state,
                    c.lat,
                    c.lng,
                    c.tank_size,
                    cp.urgency_score,
                    cp.predicted_quantity,
                    cp.predicted_next_order_date,
                    cp.recommendation,
                    cp.days_since_delivery,
                    cp.confidence_score
                FROM customer_predictions cp
                JOIN customers c ON cp.customer_id = c.id
                WHERE cp.company_id = $1
                AND c.preferred_dc_id = $2
                AND c.status = 'active'
                AND cp.urgency_score >= $3
                AND c.lat IS NOT NULL
                AND c.lng IS NOT NULL
                ORDER BY cp.urgency_score DESC, cp.confidence_score DESC
                LIMIT $4
            `, [companyId, dcId, minUrgency, maxCustomers]);

            return success({
                suggestions: suggestions.rows,
                dcId,
                totalSuggested: suggestions.rows.length
            });
        }

        // =====================================================
        // GET /predictions/volume-forecast - Product volume forecast by month
        // =====================================================
        if (method === 'GET' && path === '/volume-forecast') {
            const months = parseInt(event.queryStringParameters?.months) || 6;
            const dcId = event.queryStringParameters?.dc_id;

            // Get all products
            const products = await query(`
                SELECT id, name, category, unit, sku
                FROM products 
                WHERE company_id = $1 AND status = 'active'
                ORDER BY category, name
            `, [companyId]);

            // Get seasonal factors for upcoming months
            const seasonalResult = await query(`
                SELECT month, factor
                FROM seasonal_factors
                WHERE company_id = $1 AND product_category IS NULL
            `, [companyId]);
            
            const seasonalFactors = {};
            seasonalResult.rows.forEach(r => {
                seasonalFactors[r.month] = parseFloat(r.factor) || 1.0;
            });

            // Get customer predictions with their assigned products
            let customerQuery = `
                SELECT 
                    cp.customer_id,
                    cp.predicted_next_order_date,
                    cp.predicted_quantity,
                    cp.delivery_frequency_days,
                    cp.avg_daily_consumption,
                    c.preferred_dc_id
                FROM customer_predictions cp
                JOIN customers c ON cp.customer_id = c.id
                WHERE cp.company_id = $1 
                AND c.status = 'active'
                AND cp.delivery_frequency_days > 0
            `;
            let params = [companyId];
            
            if (dcId) {
                customerQuery += ` AND c.preferred_dc_id = $2`;
                params.push(dcId);
            }

            const customerPredictions = await query(customerQuery, params);

            // Get customer-product assignments with historical quantities
            const customerProducts = await query(`
                SELECT 
                    cprod.customer_id,
                    cprod.product_id,
                    p.name as product_name,
                    p.category as product_category,
                    p.unit as product_unit,
                    -- Get average quantity from delivery history
                    COALESCE(
                        (SELECT AVG(di.quantity_delivered) 
                         FROM delivery_items di 
                         JOIN route_run_stops rrs ON di.stop_id = rrs.id
                         WHERE di.product_id = cprod.product_id 
                         AND rrs.customer_id = cprod.customer_id
                         AND rrs.status = 'completed'
                         AND di.quantity_delivered > 0),
                        1
                    ) as avg_quantity
                FROM customer_products cprod
                JOIN products p ON cprod.product_id = p.id
                WHERE cprod.company_id = $1
                AND cprod.is_enabled = true
            `, [companyId]);

            // Build lookup: customer_id -> array of products
            const customerProductMap = {};
            customerProducts.rows.forEach(cp => {
                if (!customerProductMap[cp.customer_id]) {
                    customerProductMap[cp.customer_id] = [];
                }
                customerProductMap[cp.customer_id].push({
                    productId: cp.product_id,
                    productName: cp.product_name,
                    category: cp.product_category,
                    unit: cp.product_unit,
                    avgQuantity: parseFloat(cp.avg_quantity) || 1
                });
            });

            // Generate month labels for next N months
            const now = new Date();
            const monthLabels = [];
            for (let i = 0; i < months; i++) {
                const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
                monthLabels.push({
                    year: d.getFullYear(),
                    month: d.getMonth() + 1,
                    label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
                });
            }

            // Initialize forecast structure: { productId: { monthKey: quantity } }
            const forecast = {};
            products.rows.forEach(p => {
                forecast[p.id] = {
                    product: p,
                    months: {}
                };
                monthLabels.forEach(ml => {
                    forecast[p.id].months[`${ml.year}-${ml.month}`] = 0;
                });
            });

            // Project deliveries for each customer across future months
            customerPredictions.rows.forEach(cp => {
                const products = customerProductMap[cp.customer_id] || [];
                if (products.length === 0) return;

                const frequencyDays = parseFloat(cp.delivery_frequency_days) || 30;
                let nextDelivery = cp.predicted_next_order_date 
                    ? new Date(cp.predicted_next_order_date) 
                    : new Date();

                // Project deliveries for the forecast period
                const endDate = new Date(now.getFullYear(), now.getMonth() + months, 0);
                
                while (nextDelivery <= endDate) {
                    const deliveryMonth = nextDelivery.getMonth() + 1;
                    const deliveryYear = nextDelivery.getFullYear();
                    const monthKey = `${deliveryYear}-${deliveryMonth}`;

                    // Get seasonal factor for this month
                    const seasonalFactor = seasonalFactors[deliveryMonth] || 1.0;

                    // Add each product's predicted quantity
                    products.forEach(prod => {
                        if (forecast[prod.productId]) {
                            // Adjust quantity by seasonal factor
                            const adjustedQty = prod.avgQuantity * seasonalFactor;
                            if (forecast[prod.productId].months[monthKey] !== undefined) {
                                forecast[prod.productId].months[monthKey] += adjustedQty;
                            }
                        }
                    });

                    // Move to next predicted delivery (adjusted by seasonal factor)
                    const adjustedFrequency = frequencyDays / (seasonalFactors[deliveryMonth] || 1.0);
                    nextDelivery = new Date(nextDelivery.getTime() + adjustedFrequency * 24 * 60 * 60 * 1000);
                }
            });

            // Convert to array format for frontend
            const forecastData = Object.values(forecast).map(f => ({
                productId: f.product.id,
                productName: f.product.name,
                category: f.product.category,
                unit: f.product.unit,
                sku: f.product.sku,
                monthlyVolumes: monthLabels.map(ml => ({
                    year: ml.year,
                    month: ml.month,
                    label: ml.label,
                    volume: Math.round(f.months[`${ml.year}-${ml.month}`] * 10) / 10
                })),
                totalVolume: Math.round(
                    Object.values(f.months).reduce((sum, v) => sum + v, 0) * 10
                ) / 10
            })).filter(f => f.totalVolume > 0) // Only include products with forecasted volume
              .sort((a, b) => b.totalVolume - a.totalVolume); // Sort by total volume desc

            // Calculate totals by month
            const monthlyTotals = monthLabels.map(ml => {
                const key = `${ml.year}-${ml.month}`;
                let total = 0;
                Object.values(forecast).forEach(f => {
                    total += f.months[key] || 0;
                });
                return {
                    ...ml,
                    totalVolume: Math.round(total * 10) / 10
                };
            });

            // Group by category
            const byCategory = {};
            forecastData.forEach(f => {
                const cat = f.category || 'Other';
                if (!byCategory[cat]) {
                    byCategory[cat] = {
                        category: cat,
                        products: [],
                        totalVolume: 0
                    };
                }
                byCategory[cat].products.push(f);
                byCategory[cat].totalVolume += f.totalVolume;
            });

            return success({
                monthLabels,
                products: forecastData,
                byCategory: Object.values(byCategory).sort((a, b) => b.totalVolume - a.totalVolume),
                monthlyTotals,
                grandTotal: forecastData.reduce((sum, f) => sum + f.totalVolume, 0),
                customersAnalyzed: customerPredictions.rows.length,
                forecastMonths: months
            });
        }

        return error('Not found', 404);

    } catch (err) {
        console.error('Predictions API error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};

// =====================================================
// Helper: Calculate customer consumption patterns
// =====================================================
async function calculateCustomerConsumption(companyId, customerId) {
    const deliveries = await query(`
        SELECT 
            rrs.departed_at::DATE as delivery_date,
            COALESCE(rrs.gallons_delivered, 0) as gallons,
            rrs.revenue
        FROM route_run_stops rrs
        JOIN route_runs rr ON rrs.route_run_id = rr.id
        WHERE rr.company_id = $1
        AND rrs.customer_id = $2
        AND rrs.status = 'completed'
        AND rrs.departed_at IS NOT NULL
        ORDER BY rrs.departed_at
    `, [companyId, customerId]);

    if (deliveries.rows.length < 2) {
        return {
            avgDailyConsumption: 0,
            avgDeliveryGallons: deliveries.rows[0]?.gallons || 0,
            deliveryFrequencyDays: 30,
            totalDeliveries: deliveries.rows.length,
            dataQualityScore: deliveries.rows.length * 5
        };
    }

    let totalGallons = 0;
    let totalDays = 0;
    let prevDate = null;

    for (const d of deliveries.rows) {
        totalGallons += parseFloat(d.gallons) || 0;
        if (prevDate) {
            totalDays += Math.floor((new Date(d.delivery_date) - new Date(prevDate)) / (1000 * 60 * 60 * 24));
        }
        prevDate = d.delivery_date;
    }

    const deliveryCount = deliveries.rows.length;
    const avgDailyConsumption = totalDays > 0 ? totalGallons / totalDays : 0;
    const avgDeliveryGallons = totalGallons / deliveryCount;
    const deliveryFrequencyDays = totalDays / (deliveryCount - 1);
    const dataQualityScore = Math.min(100, deliveryCount * 10);

    return {
        avgDailyConsumption,
        avgDeliveryGallons,
        deliveryFrequencyDays,
        totalDeliveries: deliveryCount,
        dataQualityScore
    };
}
