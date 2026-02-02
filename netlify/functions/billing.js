// Billing API - Super Admin endpoints
const { query } = require('./utils/db');
const { requireSuperAdmin } = require('./utils/auth');
const { success, error, handleOptions, parseBody } = require('./utils/response');
const { sendInvoiceEmail } = require('./utils/email');

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/billing', '');
    const method = event.httpMethod;

    try {
        // All billing admin routes require super admin
        const authResult = requireSuperAdmin(event);
        if (authResult.error) {
            return error(authResult.error, authResult.status);
        }

        // GET /billing/invoices - List all invoices
        if (method === 'GET' && path === '/invoices') {
            return await listInvoices(event);
        }

        // POST /billing/invoices - Create invoice for a company
        if (method === 'POST' && path === '/invoices') {
            return await createInvoice(event, authResult.admin);
        }

        // GET /billing/invoices/:id - Get invoice details
        if (method === 'GET' && path.match(/^\/invoices\/[a-f0-9-]+$/)) {
            const invoiceId = path.split('/')[2];
            return await getInvoice(invoiceId);
        }

        // PUT /billing/invoices/:id - Update invoice (mark paid, cancel, etc)
        if (method === 'PUT' && path.match(/^\/invoices\/[a-f0-9-]+$/)) {
            const invoiceId = path.split('/')[2];
            return await updateInvoice(invoiceId, event, authResult.admin);
        }

        // POST /billing/invoices/:id/payment - Record manual payment
        if (method === 'POST' && path.match(/^\/invoices\/[a-f0-9-]+\/payment$/)) {
            const invoiceId = path.split('/')[2];
            return await recordPayment(invoiceId, event, authResult.admin);
        }

        // GET /billing/payments - List all payments
        if (method === 'GET' && path === '/payments') {
            return await listPayments(event);
        }

        // GET /billing/companies/:id/ledger - Get company ledger
        if (method === 'GET' && path.match(/^\/companies\/[a-f0-9-]+\/ledger$/)) {
            const companyId = path.split('/')[2];
            return await getCompanyLedger(companyId);
        }

        // GET /billing/companies/:id/balance - Get company balance
        if (method === 'GET' && path.match(/^\/companies\/[a-f0-9-]+\/balance$/)) {
            const companyId = path.split('/')[2];
            return await getCompanyBalance(companyId);
        }

        // POST /billing/generate-monthly - Generate invoices for all active companies
        if (method === 'POST' && path === '/generate-monthly') {
            return await generateMonthlyInvoices(authResult.admin);
        }

        // GET /billing/pricing - Get plan pricing
        if (method === 'GET' && path === '/pricing') {
            return await getPricing();
        }

        // PUT /billing/pricing/:plan - Update plan pricing
        if (method === 'PUT' && path.match(/^\/pricing\/[a-z]+$/)) {
            const plan = path.split('/')[2];
            return await updatePricing(plan, event);
        }

        // GET /billing/summary - Dashboard summary
        if (method === 'GET' && path === '/summary') {
            return await getBillingSummary();
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Billing error:', err);
        return error('Internal server error', 500);
    }
};

async function listInvoices(event) {
    const params = event.queryStringParameters || {};
    const status = params.status;
    const companyId = params.company_id;
    const limit = parseInt(params.limit) || 50;
    const offset = parseInt(params.offset) || 0;

    let whereClause = 'WHERE 1=1';
    const values = [];
    let paramCount = 0;

    if (status) {
        paramCount++;
        whereClause += ` AND i.status = $${paramCount}`;
        values.push(status);
    }

    if (companyId) {
        paramCount++;
        whereClause += ` AND i.company_id = $${paramCount}`;
        values.push(companyId);
    }

    values.push(limit, offset);

    const result = await query(`
        SELECT i.*, c.name as company_name, c.subdomain
        FROM invoices i
        JOIN companies c ON i.company_id = c.id
        ${whereClause}
        ORDER BY i.created_at DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `, values);

    const countResult = await query(`
        SELECT COUNT(*) as total FROM invoices i ${whereClause}
    `, values.slice(0, paramCount));

    return success({
        invoices: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit,
        offset
    });
}

async function createInvoice(event, admin) {
    const body = parseBody(event);
    const { company_id, amount, description, due_date, period_start, period_end } = body;

    if (!company_id || !amount) {
        return error('Company ID and amount required', 400);
    }

    // Get company info
    const companyResult = await query('SELECT * FROM companies WHERE id = $1', [company_id]);
    if (companyResult.rows.length === 0) {
        return error('Company not found', 404);
    }
    const company = companyResult.rows[0];

    // Generate invoice number
    const invoiceNumResult = await query('SELECT generate_invoice_number() as num');
    const invoiceNumber = invoiceNumResult.rows[0].num;

    const total = parseFloat(amount);
    const dueDate = due_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const periodStart = period_start || new Date().toISOString().split('T')[0];
    const periodEnd = period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const result = await query(`
        INSERT INTO invoices (company_id, invoice_number, period_start, period_end, plan, amount, total, due_date, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
    `, [company_id, invoiceNumber, periodStart, periodEnd, company.plan, total, total, dueDate, description || null]);

    const invoice = result.rows[0];

    // Add to ledger
    await addLedgerEntry(company_id, 'charge', total, `Invoice ${invoiceNumber}`, 'invoice', invoice.id, 'super_admin', admin.adminId);

    return success(invoice, 201);
}

async function getInvoice(invoiceId) {
    const result = await query(`
        SELECT i.*, c.name as company_name, c.subdomain, c.email as company_email
        FROM invoices i
        JOIN companies c ON i.company_id = c.id
        WHERE i.id = $1
    `, [invoiceId]);

    if (result.rows.length === 0) {
        return error('Invoice not found', 404);
    }

    // Get payments for this invoice
    const payments = await query(`
        SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC
    `, [invoiceId]);

    return success({
        ...result.rows[0],
        payments: payments.rows
    });
}

async function updateInvoice(invoiceId, event, admin) {
    const body = parseBody(event);
    const { status, notes } = body;

    const updates = [];
    const values = [];
    let paramCount = 0;

    if (status) {
        paramCount++;
        updates.push(`status = $${paramCount}`);
        values.push(status);

        if (status === 'paid') {
            updates.push('paid_at = CURRENT_TIMESTAMP');
        }
    }

    if (notes !== undefined) {
        paramCount++;
        updates.push(`notes = $${paramCount}`);
        values.push(notes);
    }

    if (updates.length === 0) {
        return error('No updates provided', 400);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(invoiceId);

    const result = await query(`
        UPDATE invoices SET ${updates.join(', ')} WHERE id = $${paramCount + 1} RETURNING *
    `, values);

    if (result.rows.length === 0) {
        return error('Invoice not found', 404);
    }

    return success(result.rows[0]);
}

async function recordPayment(invoiceId, event, admin) {
    const body = parseBody(event);
    const { amount, payment_method, transaction_id, description, send_email } = body;

    if (!amount) {
        return error('Amount required', 400);
    }

    // Get invoice
    const invoiceResult = await query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
    if (invoiceResult.rows.length === 0) {
        return error('Invoice not found', 404);
    }
    const invoice = invoiceResult.rows[0];

    // Get company for email
    const companyResult = await query('SELECT * FROM companies WHERE id = $1', [invoice.company_id]);
    const company = companyResult.rows[0];

    // Create payment record
    const paymentResult = await query(`
        INSERT INTO payments (company_id, invoice_id, amount, payment_method, transaction_id, description, processed_by, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')
        RETURNING *
    `, [invoice.company_id, invoiceId, amount, payment_method || 'manual', transaction_id, description, admin.adminId]);

    const payment = paymentResult.rows[0];

    // Add to ledger
    await addLedgerEntry(invoice.company_id, 'payment', -parseFloat(amount), `Payment for ${invoice.invoice_number}`, 'payment', payment.id, 'super_admin', admin.adminId);

    // Check if invoice is fully paid
    const paymentsTotal = await query(`
        SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE invoice_id = $1 AND status = 'completed'
    `, [invoiceId]);

    let invoicePaid = false;
    if (parseFloat(paymentsTotal.rows[0].total) >= parseFloat(invoice.total)) {
        await query(`UPDATE invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = $1`, [invoiceId]);
        invoicePaid = true;
    }

    // Send payment receipt email (default to true, can be disabled)
    if (send_email !== false && invoicePaid && company) {
        try {
            const updatedInvoice = { ...invoice, status: 'paid', paid_at: new Date() };
            await sendInvoiceEmail(updatedInvoice, company, payment);
        } catch (emailErr) {
            console.error('Failed to send payment receipt email:', emailErr);
            // Don't fail the request if email fails
        }
    }

    return success({ ...payment, invoice_paid: invoicePaid }, 201);
}

async function listPayments(event) {
    const params = event.queryStringParameters || {};
    const limit = parseInt(params.limit) || 50;
    const offset = parseInt(params.offset) || 0;

    const result = await query(`
        SELECT p.*, c.name as company_name, i.invoice_number
        FROM payments p
        JOIN companies c ON p.company_id = c.id
        LEFT JOIN invoices i ON p.invoice_id = i.id
        ORDER BY p.created_at DESC
        LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return success({ payments: result.rows });
}

async function getCompanyLedger(companyId) {
    const result = await query(`
        SELECT * FROM billing_ledger
        WHERE company_id = $1
        ORDER BY created_at DESC
        LIMIT 100
    `, [companyId]);

    return success({ ledger: result.rows });
}

async function getCompanyBalance(companyId) {
    const result = await query('SELECT balance FROM companies WHERE id = $1', [companyId]);
    
    if (result.rows.length === 0) {
        return error('Company not found', 404);
    }

    // Also get pending invoices
    const pending = await query(`
        SELECT COALESCE(SUM(total), 0) as pending_amount, COUNT(*) as pending_count
        FROM invoices WHERE company_id = $1 AND status = 'pending'
    `, [companyId]);

    return success({
        balance: parseFloat(result.rows[0].balance) || 0,
        pending_amount: parseFloat(pending.rows[0].pending_amount) || 0,
        pending_invoices: parseInt(pending.rows[0].pending_count) || 0
    });
}

async function generateMonthlyInvoices(admin) {
    // Get all active companies with paid plans
    const companies = await query(`
        SELECT c.*, pp.monthly_price
        FROM companies c
        JOIN plan_pricing pp ON c.plan = pp.plan
        WHERE c.status = 'active' AND c.plan != 'trial' AND pp.monthly_price > 0
    `);

    const periodStart = new Date();
    periodStart.setDate(1); // First of current month
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    periodEnd.setDate(0); // Last day of current month

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 15); // Due in 15 days

    const invoices = [];
    for (const company of companies.rows) {
        // Check if invoice already exists for this period
        const existing = await query(`
            SELECT id FROM invoices 
            WHERE company_id = $1 AND period_start = $2
        `, [company.id, periodStart.toISOString().split('T')[0]]);

        if (existing.rows.length > 0) {
            continue; // Skip, already invoiced
        }

        // Generate invoice number
        const invoiceNumResult = await query('SELECT generate_invoice_number() as num');
        const invoiceNumber = invoiceNumResult.rows[0].num;

        const result = await query(`
            INSERT INTO invoices (company_id, invoice_number, period_start, period_end, plan, amount, total, due_date, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [
            company.id,
            invoiceNumber,
            periodStart.toISOString().split('T')[0],
            periodEnd.toISOString().split('T')[0],
            company.plan,
            company.monthly_price,
            company.monthly_price,
            dueDate.toISOString().split('T')[0],
            `Monthly subscription - ${company.plan} plan`
        ]);

        const invoice = result.rows[0];
        invoices.push(invoice);

        // Add to ledger
        await addLedgerEntry(company.id, 'charge', company.monthly_price, `Invoice ${invoiceNumber}`, 'invoice', invoice.id, 'super_admin', admin.adminId);
    }

    return success({ 
        message: `Generated ${invoices.length} invoices`,
        invoices 
    });
}

async function getPricing() {
    const result = await query('SELECT * FROM plan_pricing ORDER BY monthly_price');
    return success({ pricing: result.rows });
}

async function updatePricing(plan, event) {
    const body = parseBody(event);
    const { monthly_price, annual_price, name, description } = body;

    const updates = [];
    const values = [];
    let paramCount = 0;

    if (monthly_price !== undefined) {
        paramCount++;
        updates.push(`monthly_price = $${paramCount}`);
        values.push(monthly_price);
    }
    if (annual_price !== undefined) {
        paramCount++;
        updates.push(`annual_price = $${paramCount}`);
        values.push(annual_price);
    }
    if (name) {
        paramCount++;
        updates.push(`name = $${paramCount}`);
        values.push(name);
    }
    if (description) {
        paramCount++;
        updates.push(`description = $${paramCount}`);
        values.push(description);
    }

    if (updates.length === 0) {
        return error('No updates provided', 400);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(plan);

    const result = await query(`
        UPDATE plan_pricing SET ${updates.join(', ')} WHERE plan = $${paramCount + 1} RETURNING *
    `, values);

    return success(result.rows[0]);
}

async function getBillingSummary() {
    // Total outstanding
    const outstanding = await query(`
        SELECT COALESCE(SUM(total), 0) as amount FROM invoices WHERE status = 'pending'
    `);

    // This month's revenue
    const monthStart = new Date();
    monthStart.setDate(1);
    const revenue = await query(`
        SELECT COALESCE(SUM(amount), 0) as amount FROM payments 
        WHERE status = 'completed' AND created_at >= $1
    `, [monthStart.toISOString()]);

    // Overdue invoices
    const overdue = await query(`
        SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as amount
        FROM invoices WHERE status = 'pending' AND due_date < CURRENT_DATE
    `);

    // Recent invoices
    const recentInvoices = await query(`
        SELECT i.*, c.name as company_name
        FROM invoices i JOIN companies c ON i.company_id = c.id
        ORDER BY i.created_at DESC LIMIT 5
    `);

    // Recent payments
    const recentPayments = await query(`
        SELECT p.*, c.name as company_name
        FROM payments p JOIN companies c ON p.company_id = c.id
        ORDER BY p.created_at DESC LIMIT 5
    `);

    return success({
        outstanding: parseFloat(outstanding.rows[0].amount) || 0,
        revenue_this_month: parseFloat(revenue.rows[0].amount) || 0,
        overdue_count: parseInt(overdue.rows[0].count) || 0,
        overdue_amount: parseFloat(overdue.rows[0].amount) || 0,
        recent_invoices: recentInvoices.rows,
        recent_payments: recentPayments.rows
    });
}

async function addLedgerEntry(companyId, type, amount, description, refType, refId, createdByType, createdById) {
    // Get current balance
    const balanceResult = await query('SELECT balance FROM companies WHERE id = $1', [companyId]);
    const currentBalance = parseFloat(balanceResult.rows[0]?.balance) || 0;
    const newBalance = currentBalance + parseFloat(amount);

    // Insert ledger entry
    await query(`
        INSERT INTO billing_ledger (company_id, type, amount, balance, description, reference_type, reference_id, created_by_type, created_by_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [companyId, type, amount, newBalance, description, refType, refId, createdByType, createdById]);

    // Update company balance
    await query('UPDATE companies SET balance = $1 WHERE id = $2', [newBalance, companyId]);
}
