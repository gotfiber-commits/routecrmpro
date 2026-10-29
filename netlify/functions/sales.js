// =====================================================================
// SALES & COMMISSION API
// =====================================================================
// Endpoints:
//   Reps
//     GET    /sales/reps
//     POST   /sales/reps
//     PUT    /sales/reps/:id
//     DELETE /sales/reps/:id            (soft: status=inactive)
//   Commission rates (company-wide, per product unit type)
//     GET    /sales/rates
//     PUT    /sales/rates               body: { rates: [{unit_type, rate_percent}] }
//   Reports
//     GET    /sales/report?period=week|month|year&start=&end=&rep_id=
//     GET    /sales/rep/:id?start=&end= (per-rep detail w/ customer breakdown)
//   Holding / review queue
//     GET    /sales/holding             (sales stamped to a rep != customer's current rep)
//     POST   /sales/holding/scan        (move mismatched settled rows into holding)
//     POST   /sales/holding/:id/resolve body: { resolution, resolved_rep_id? }
//   Backfill (stamp historical completed deliveries that predate this feature)
//     POST   /sales/backfill

const { query, setTenant } = require('./utils/db');
const { success, error, parseBody } = require('./utils/response');
const { requireAuth } = require('./utils/auth');

exports.handler = async (event) => {
    const authResult = requireAuth(event);
    if (authResult.error) return error(authResult.error, authResult.status);
    const user = authResult.user;
    const companyId = user.companyId;
    setTenant(companyId);

    const path = event.path.replace('/.netlify/functions/sales', '');
    const method = event.httpMethod;
    const params = event.queryStringParameters || {};

    try {
        // ---------------- REPS ----------------
        if (method === 'GET' && path === '/reps') {
            const result = await query(
                `SELECT sr.*,
                        (SELECT COUNT(*) FROM customers c WHERE c.sales_rep_id = sr.id) AS customer_count
                 FROM sales_reps sr
                 WHERE sr.company_id = $1
                 ORDER BY sr.status ASC, sr.name ASC`,
                [companyId]
            );
            return success(result.rows);
        }

        if (method === 'POST' && path === '/reps') {
            const b = parseBody(event);
            if (!b.name) return error('Name is required', 400);
            const result = await query(
                `INSERT INTO sales_reps (company_id, code, name, email, phone, status, notes)
                 VALUES ($1,$2,$3,$4,$5,COALESCE($6,'active'),$7) RETURNING *`,
                [companyId, b.code || null, b.name, b.email || null, b.phone || null, b.status || 'active', b.notes || null]
            );
            return success(result.rows[0]);
        }

        if (method === 'PUT' && path.match(/^\/reps\/[a-f0-9-]+$/)) {
            const id = path.split('/')[2];
            const b = parseBody(event);
            const result = await query(
                `UPDATE sales_reps
                 SET code=COALESCE($1,code), name=COALESCE($2,name), email=$3, phone=$4,
                     status=COALESCE($5,status), notes=$6, updated_at=NOW()
                 WHERE id=$7 AND company_id=$8 RETURNING *`,
                [b.code, b.name, b.email || null, b.phone || null, b.status, b.notes || null, id, companyId]
            );
            if (result.rows.length === 0) return error('Sales rep not found', 404);
            return success(result.rows[0]);
        }

        if (method === 'DELETE' && path.match(/^\/reps\/[a-f0-9-]+$/)) {
            const id = path.split('/')[2];
            // Soft-deactivate so historical attributions remain intact.
            const result = await query(
                `UPDATE sales_reps SET status='inactive', updated_at=NOW()
                 WHERE id=$1 AND company_id=$2 RETURNING id`,
                [id, companyId]
            );
            if (result.rows.length === 0) return error('Sales rep not found', 404);
            return success({ deactivated: true });
        }

        // ---------------- COMMISSION RATES ----------------
        if (method === 'GET' && path === '/rates') {
            const result = await query(
                `SELECT unit_type, rate_percent FROM commission_rates
                 WHERE company_id=$1 ORDER BY unit_type`,
                [companyId]
            );
            return success(result.rows);
        }

        if (method === 'PUT' && path === '/rates') {
            const b = parseBody(event);
            const rates = Array.isArray(b.rates) ? b.rates : [];
            for (const r of rates) {
                if (!r.unit_type) continue;
                const pct = parseFloat(r.rate_percent) || 0;
                await query(
                    `INSERT INTO commission_rates (company_id, unit_type, rate_percent, updated_at)
                     VALUES ($1,$2,$3,NOW())
                     ON CONFLICT (company_id, unit_type)
                     DO UPDATE SET rate_percent=$3, updated_at=NOW()`,
                    [companyId, String(r.unit_type).toLowerCase(), pct]
                );
            }
            return success({ updated: rates.length });
        }

        // ---------------- REPORTS ----------------
        if (method === 'GET' && path === '/report') {
            const period = ['week', 'month', 'year'].includes(params.period) ? params.period : 'month';
            const trunc = period; // date_trunc unit
            const start = params.start || null;
            const end = params.end || null;
            const repFilter = params.rep_id ? 'AND sa.sales_rep_id = $4' : '';
            const args = [companyId, start, end];
            if (params.rep_id) args.push(params.rep_id);

            // Per-rep totals over the whole range
            const totals = await query(
                `SELECT
                    sa.sales_rep_id,
                    COALESCE(sr.name, 'Unassigned / Holding') AS rep_name,
                    COUNT(*) AS line_count,
                    SUM(sa.quantity) AS total_quantity,
                    SUM(sa.revenue) AS total_revenue,
                    SUM(sa.commission_amount) AS total_commission,
                    SUM(CASE WHEN sa.review_status='holding' THEN sa.commission_amount ELSE 0 END) AS holding_commission
                 FROM sales_attributions sa
                 LEFT JOIN sales_reps sr ON sr.id = sa.sales_rep_id
                 WHERE sa.company_id = $1
                   AND ($2::date IS NULL OR sa.sale_date >= $2::date)
                   AND ($3::date IS NULL OR sa.sale_date <= $3::date)
                   ${repFilter}
                 GROUP BY sa.sales_rep_id, sr.name
                 ORDER BY total_revenue DESC NULLS LAST`,
                args
            );

            // Time series bucketed by week/month/year
            const series = await query(
                `SELECT
                    date_trunc('${trunc}', sa.sale_date)::date AS period_start,
                    sa.sales_rep_id,
                    COALESCE(sr.name, 'Unassigned / Holding') AS rep_name,
                    SUM(sa.revenue) AS revenue,
                    SUM(sa.commission_amount) AS commission
                 FROM sales_attributions sa
                 LEFT JOIN sales_reps sr ON sr.id = sa.sales_rep_id
                 WHERE sa.company_id = $1
                   AND ($2::date IS NULL OR sa.sale_date >= $2::date)
                   AND ($3::date IS NULL OR sa.sale_date <= $3::date)
                   ${repFilter}
                 GROUP BY period_start, sa.sales_rep_id, sr.name
                 ORDER BY period_start ASC`,
                args
            );

            return success({ period, totals: totals.rows, series: series.rows });
        }

        if (method === 'GET' && path.match(/^\/rep\/[a-f0-9-]+$/)) {
            const repId = path.split('/')[2];
            const start = params.start || null;
            const end = params.end || null;
            const rep = await query(`SELECT * FROM sales_reps WHERE id=$1 AND company_id=$2`, [repId, companyId]);
            if (rep.rows.length === 0) return error('Sales rep not found', 404);

            const byCustomer = await query(
                `SELECT c.id AS customer_id, c.name AS customer_name, c.code AS customer_code,
                        SUM(sa.revenue) AS revenue,
                        SUM(sa.commission_amount) AS commission,
                        SUM(sa.quantity) AS quantity
                 FROM sales_attributions sa
                 JOIN customers c ON c.id = sa.customer_id
                 WHERE sa.company_id=$1 AND sa.sales_rep_id=$2
                   AND ($3::date IS NULL OR sa.sale_date >= $3::date)
                   AND ($4::date IS NULL OR sa.sale_date <= $4::date)
                 GROUP BY c.id, c.name, c.code
                 ORDER BY revenue DESC`,
                [companyId, repId, start, end]
            );

            const byProductType = await query(
                `SELECT sa.unit_type,
                        SUM(sa.revenue) AS revenue,
                        SUM(sa.commission_amount) AS commission,
                        SUM(sa.quantity) AS quantity
                 FROM sales_attributions sa
                 WHERE sa.company_id=$1 AND sa.sales_rep_id=$2
                   AND ($3::date IS NULL OR sa.sale_date >= $3::date)
                   AND ($4::date IS NULL OR sa.sale_date <= $4::date)
                 GROUP BY sa.unit_type
                 ORDER BY revenue DESC`,
                [companyId, repId, start, end]
            );

            return success({ rep: rep.rows[0], byCustomer: byCustomer.rows, byProductType: byProductType.rows });
        }

        // ---------------- HOLDING / REVIEW QUEUE ----------------
        if (method === 'GET' && path === '/holding') {
            const result = await query(
                `SELECT sa.*, c.name AS customer_name, c.code AS customer_code,
                        c.sales_rep_id AS current_rep_id,
                        origrep.name AS original_rep_name,
                        currep.name AS current_rep_name,
                        p.name AS product_name
                 FROM sales_attributions sa
                 LEFT JOIN customers c ON c.id = sa.customer_id
                 LEFT JOIN sales_reps origrep ON origrep.id = sa.sales_rep_id
                 LEFT JOIN sales_reps currep ON currep.id = c.sales_rep_id
                 LEFT JOIN products p ON p.id = sa.product_id
                 WHERE sa.company_id=$1 AND sa.review_status='holding'
                 ORDER BY sa.sale_date DESC
                 LIMIT 500`,
                [companyId]
            );
            return success(result.rows);
        }

        // Scan: flag settled rows whose stamped rep != customer's current rep.
        if (method === 'POST' && path === '/holding/scan') {
            const result = await query(
                `UPDATE sales_attributions sa
                 SET review_status='holding'
                 FROM customers c
                 WHERE sa.customer_id = c.id
                   AND sa.company_id = $1
                   AND sa.review_status = 'settled'
                   AND COALESCE(sa.sales_rep_id,'00000000-0000-0000-0000-000000000000')
                       <> COALESCE(c.sales_rep_id,'00000000-0000-0000-0000-000000000000')
                 RETURNING sa.id`,
                [companyId]
            );
            return success({ moved_to_holding: result.rowCount });
        }

        if (method === 'POST' && path.match(/^\/holding\/[a-f0-9-]+\/resolve$/)) {
            const id = path.split('/')[2];
            const b = parseBody(event);
            const resolution = b.resolution; // keep_original | reassign_current | void | split
            if (!['keep_original', 'reassign_current', 'void', 'split'].includes(resolution)) {
                return error('Invalid resolution', 400);
            }

            // Load the row + customer's current rep
            const row = await query(
                `SELECT sa.*, c.sales_rep_id AS current_rep_id
                 FROM sales_attributions sa
                 LEFT JOIN customers c ON c.id = sa.customer_id
                 WHERE sa.id=$1 AND sa.company_id=$2`,
                [id, companyId]
            );
            if (row.rows.length === 0) return error('Attribution not found', 404);
            const sa = row.rows[0];

            let newRepId = sa.sales_rep_id;
            let commission = parseFloat(sa.commission_amount) || 0;
            if (resolution === 'reassign_current') {
                newRepId = sa.current_rep_id || null;
            } else if (resolution === 'void') {
                newRepId = null;
                commission = 0;
            } else if (resolution === 'split') {
                // Explicit target rep for a manual split decision
                newRepId = b.resolved_rep_id || sa.current_rep_id || sa.sales_rep_id;
            }
            // keep_original leaves sales_rep_id as-is

            const updated = await query(
                `UPDATE sales_attributions
                 SET sales_rep_id=$1, commission_amount=$2,
                     review_status='resolved', resolution=$3,
                     resolved_rep_id=$4, resolved_by=$5, resolved_at=NOW()
                 WHERE id=$6 AND company_id=$7 RETURNING *`,
                [newRepId, commission, resolution, b.resolved_rep_id || newRepId, user.userId || null, id, companyId]
            );
            return success(updated.rows[0]);
        }

        // ---------------- BACKFILL ----------------
        // Stamp historical completed delivery lines that have no attribution yet,
        // using the customer's CURRENT rep (best available for past data) and the
        // current commission rate for each product's unit type.
        if (method === 'POST' && path === '/backfill') {
            const result = await query(
                `INSERT INTO sales_attributions
                    (company_id, delivery_item_id, stop_id, customer_id, product_id,
                     sales_rep_id, unit_type, quantity, revenue, rate_percent,
                     commission_amount, sale_date, review_status)
                 SELECT
                    di.company_id, di.id, di.stop_id, rrs.customer_id, di.product_id,
                    c.sales_rep_id,
                    LOWER(COALESCE(p.unit,'each')),
                    di.quantity_delivered,
                    di.line_total,
                    COALESCE(cr.rate_percent, 0),
                    ROUND(di.line_total * COALESCE(cr.rate_percent,0) / 100.0, 2),
                    COALESCE(rrs.departed_at::date, CURRENT_DATE),
                    'settled'
                 FROM delivery_items di
                 JOIN route_run_stops rrs ON rrs.id = di.stop_id
                 JOIN customers c ON c.id = rrs.customer_id
                 JOIN products p ON p.id = di.product_id
                 LEFT JOIN commission_rates cr
                        ON cr.company_id = di.company_id
                       AND cr.unit_type = LOWER(COALESCE(p.unit,'each'))
                 WHERE di.company_id = $1
                   AND di.quantity_delivered > 0
                   AND di.line_total > 0
                   AND rrs.status = 'completed'
                 ON CONFLICT (delivery_item_id) DO NOTHING
                 RETURNING id`,
                [companyId]
            );
            return success({ stamped: result.rowCount });
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Sales API error:', err);
        return error('Internal server error: ' + err.message, 500);
    }
};
