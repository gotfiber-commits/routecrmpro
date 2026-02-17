// Tenant Billing API - For companies to view and pay their bills
const { query } = require('./utils/db');
const { requireAuth } = require('./utils/auth');
const { resolveTenant } = require('./utils/tenant');
const { success, error, handleOptions, parseBody } = require('./utils/response');
const { sendInvoiceEmail } = require('./utils/email');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
        return handleOptions();
    }

    const path = event.path.replace('/.netlify/functions/tenant-billing', '');
    const method = event.httpMethod;

    try {
        // Resolve tenant
        const tenant = await resolveTenant(event);
        if (!tenant.resolved) {
            return error('Company not found', 404);
        }
        const companyId = tenant.company.id;

        // Auth required for all billing routes
        const authResult = requireAuth(event);
        if (authResult.error) {
            return error(authResult.error, authResult.status);
        }

        // Verify user belongs to this company and is admin
        if (authResult.user.companyId !== companyId) {
            return error('Unauthorized', 403);
        }

        // GET /tenant-billing - Get billing overview
        if (method === 'GET' && path === '') {
            return await getBillingOverview(companyId);
        }

        // GET /tenant-billing/invoices - List company invoices
        if (method === 'GET' && path === '/invoices') {
            return await listCompanyInvoices(companyId, event);
        }

        // GET /tenant-billing/invoices/:id - Get invoice details
        if (method === 'GET' && path.match(/^\/invoices\/[a-f0-9-]+$/)) {
            const invoiceId = path.split('/')[2];
            return await getInvoiceDetails(companyId, invoiceId);
        }

        // GET /tenant-billing/payments - List company payments
        if (method === 'GET' && path === '/payments') {
            return await listCompanyPayments(companyId);
        }

        // GET /tenant-billing/ledger - Get company account history
        if (method === 'GET' && path === '/ledger') {
            return await getCompanyLedger(companyId);
        }

        // POST /tenant-billing/setup-intent - Create Stripe setup intent for saving card
        if (method === 'POST' && path === '/setup-intent') {
            return await createSetupIntent(companyId);
        }

        // POST /tenant-billing/save-payment-method - Save payment method after setup
        if (method === 'POST' && path === '/save-payment-method') {
            return await savePaymentMethod(companyId, event);
        }

        // POST /tenant-billing/enable-autopay - Enable/disable auto-pay
        if (method === 'POST' && path === '/enable-autopay') {
            return await toggleAutoPay(companyId, event);
        }

        // GET /tenant-billing/payment-method - Get saved payment method info
        if (method === 'GET' && path === '/payment-method') {
            return await getPaymentMethod(companyId);
        }

        // DELETE /tenant-billing/payment-method - Remove payment method
        if (method === 'DELETE' && path === '/payment-method') {
            return await removePaymentMethod(companyId);
        }

        // POST /tenant-billing/pay/:invoiceId - Pay invoice now
        if (method === 'POST' && path.match(/^\/pay\/[a-f0-9-]+$/)) {
            const invoiceId = path.split('/')[2];
            return await payInvoiceNow(companyId, invoiceId);
        }

        // GET /tenant-billing/stripe-config - Get Stripe publishable key
        if (method === 'GET' && path === '/stripe-config') {
            return success({ 
                publishableKey: STRIPE_PUBLISHABLE_KEY || null,
                enabled: !!STRIPE_SECRET_KEY 
            });
        }

        return error('Not found', 404);
    } catch (err) {
        console.error('Tenant billing error:', err);
        return error('Internal server error', 500);
    }
};

async function getBillingOverview(companyId) {
    // Get company info
    const company = await query(`
        SELECT c.*, pp.name as plan_name, pp.monthly_price
        FROM companies c
        LEFT JOIN plan_pricing pp ON c.plan = pp.plan
        WHERE c.id = $1
    `, [companyId]);

    if (company.rows.length === 0) {
        return error('Company not found', 404);
    }

    // Get balance
    const balance = parseFloat(company.rows[0].balance) || 0;

    // Get pending invoices
    const pending = await query(`
        SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as amount
        FROM invoices WHERE company_id = $1 AND status = 'pending'
    `, [companyId]);

    // Get recent invoices
    const recentInvoices = await query(`
        SELECT * FROM invoices 
        WHERE company_id = $1 
        ORDER BY created_at DESC 
        LIMIT 5
    `, [companyId]);

    // Get next due invoice
    const nextDue = await query(`
        SELECT * FROM invoices 
        WHERE company_id = $1 AND status = 'pending'
        ORDER BY due_date ASC 
        LIMIT 1
    `, [companyId]);

    return success({
        company: {
            name: company.rows[0].name,
            plan: company.rows[0].plan,
            plan_name: company.rows[0].plan_name,
            monthly_price: company.rows[0].monthly_price
        },
        balance: balance,
        pending_invoices: parseInt(pending.rows[0].count) || 0,
        pending_amount: parseFloat(pending.rows[0].amount) || 0,
        recent_invoices: recentInvoices.rows,
        next_due: nextDue.rows[0] || null,
        has_payment_method: !!company.rows[0].payment_method_id,
        auto_pay: company.rows[0].auto_pay
    });
}

async function listCompanyInvoices(companyId, event) {
    const params = event.queryStringParameters || {};
    const status = params.status;
    const limit = parseInt(params.limit) || 20;
    const offset = parseInt(params.offset) || 0;

    let whereClause = 'WHERE company_id = $1';
    const values = [companyId];

    if (status) {
        whereClause += ' AND status = $2';
        values.push(status);
    }

    values.push(limit, offset);

    const result = await query(`
        SELECT * FROM invoices 
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);

    const countResult = await query(`
        SELECT COUNT(*) as total FROM invoices ${whereClause}
    `, values.slice(0, status ? 2 : 1));

    return success({
        invoices: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit,
        offset
    });
}

async function getInvoiceDetails(companyId, invoiceId) {
    const result = await query(`
        SELECT * FROM invoices WHERE id = $1 AND company_id = $2
    `, [invoiceId, companyId]);

    if (result.rows.length === 0) {
        return error('Invoice not found', 404);
    }

    // Get payments for this invoice
    const payments = await query(`
        SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC
    `, [invoiceId]);

    return success({
        invoice: result.rows[0],
        payments: payments.rows
    });
}

async function listCompanyPayments(companyId) {
    const result = await query(`
        SELECT p.*, i.invoice_number
        FROM payments p
        LEFT JOIN invoices i ON p.invoice_id = i.id
        WHERE p.company_id = $1
        ORDER BY p.created_at DESC
        LIMIT 50
    `, [companyId]);

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

async function initiatePayment(companyId, invoiceId, event) {
    // Get invoice
    const invoiceResult = await query(`
        SELECT * FROM invoices WHERE id = $1 AND company_id = $2 AND status = 'pending'
    `, [invoiceId, companyId]);

    if (invoiceResult.rows.length === 0) {
        return error('Invoice not found or already paid', 404);
    }

    const invoice = invoiceResult.rows[0];

    // Check if Stripe is configured
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    
    if (!stripeKey) {
        // Manual payment mode - just return invoice details
        return success({
            invoice: invoice,
            payment_mode: 'manual',
            instructions: 'Please contact support to arrange payment or use the payment details provided.'
        });
    }

    // Stripe payment flow
    const stripe = require('stripe')(stripeKey);

    // Get or create Stripe customer
    let stripeCustomerId;
    const companyResult = await query('SELECT stripe_customer_id, email, name FROM companies WHERE id = $1', [companyId]);
    const company = companyResult.rows[0];

    if (company.stripe_customer_id) {
        stripeCustomerId = company.stripe_customer_id;
    } else {
        const customer = await stripe.customers.create({
            email: company.email,
            name: company.name,
            metadata: { company_id: companyId }
        });
        stripeCustomerId = customer.id;
        await query('UPDATE companies SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, companyId]);
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(invoice.total * 100), // Stripe uses cents
        currency: 'usd',
        customer: stripeCustomerId,
        metadata: {
            invoice_id: invoiceId,
            invoice_number: invoice.invoice_number,
            company_id: companyId
        },
        description: `Invoice ${invoice.invoice_number}`
    });

    return success({
        invoice: invoice,
        payment_mode: 'stripe',
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id
    });
}

async function savePaymentMethod(companyId, event) {
    const body = parseBody(event);
    const { payment_method_id, auto_pay } = body;

    if (!payment_method_id) {
        return error('Payment method ID required', 400);
    }

    await query(`
        UPDATE companies 
        SET payment_method_id = $1, auto_pay = $2 
        WHERE id = $3
    `, [payment_method_id, auto_pay || false, companyId]);

    return success({ message: 'Payment method saved' });
}

async function getPaymentMethod(companyId) {
    const result = await query(`
        SELECT payment_method_id, auto_pay, stripe_customer_id 
        FROM companies WHERE id = $1
    `, [companyId]);

    if (result.rows.length === 0) {
        return error('Company not found', 404);
    }

    const company = result.rows[0];

    if (!company.payment_method_id || !STRIPE_SECRET_KEY) {
        return success({ has_payment_method: false, auto_pay: false });
    }

    // Get card details from Stripe
    try {
        const stripe = require('stripe')(STRIPE_SECRET_KEY);
        const paymentMethod = await stripe.paymentMethods.retrieve(company.payment_method_id);

        return success({
            has_payment_method: true,
            auto_pay: company.auto_pay,
            card: {
                brand: paymentMethod.card.brand,
                last4: paymentMethod.card.last4,
                exp_month: paymentMethod.card.exp_month,
                exp_year: paymentMethod.card.exp_year
            }
        });
    } catch (err) {
        return success({ has_payment_method: false, auto_pay: false });
    }
}

async function createSetupIntent(companyId) {
    if (!STRIPE_SECRET_KEY) {
        return error('Stripe not configured', 400);
    }

    const stripe = require('stripe')(STRIPE_SECRET_KEY);

    // Get or create Stripe customer
    const companyResult = await query('SELECT stripe_customer_id, email, name FROM companies WHERE id = $1', [companyId]);
    const company = companyResult.rows[0];

    let stripeCustomerId = company.stripe_customer_id;

    if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
            email: company.email,
            name: company.name,
            metadata: { company_id: companyId }
        });
        stripeCustomerId = customer.id;
        await query('UPDATE companies SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, companyId]);
    }

    // Create setup intent
    const setupIntent = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        payment_method_types: ['card'],
        metadata: { company_id: companyId }
    });

    return success({
        client_secret: setupIntent.client_secret,
        customer_id: stripeCustomerId
    });
}

async function savePaymentMethod(companyId, event) {
    const body = parseBody(event);
    const { payment_method_id, set_default } = body;

    if (!payment_method_id) {
        return error('Payment method ID required', 400);
    }

    if (!STRIPE_SECRET_KEY) {
        return error('Stripe not configured', 400);
    }

    const stripe = require('stripe')(STRIPE_SECRET_KEY);

    // Get company
    const companyResult = await query('SELECT stripe_customer_id FROM companies WHERE id = $1', [companyId]);
    const company = companyResult.rows[0];

    if (!company.stripe_customer_id) {
        return error('Stripe customer not found', 400);
    }

    try {
        // Attach payment method to customer
        await stripe.paymentMethods.attach(payment_method_id, {
            customer: company.stripe_customer_id
        });

        // Set as default payment method
        await stripe.customers.update(company.stripe_customer_id, {
            invoice_settings: { default_payment_method: payment_method_id }
        });

        // Save to database
        await query(`
            UPDATE companies 
            SET payment_method_id = $1, auto_pay = true 
            WHERE id = $2
        `, [payment_method_id, companyId]);

        // Get card details to return
        const paymentMethod = await stripe.paymentMethods.retrieve(payment_method_id);

        return success({ 
            message: 'Payment method saved',
            card: {
                brand: paymentMethod.card.brand,
                last4: paymentMethod.card.last4,
                exp_month: paymentMethod.card.exp_month,
                exp_year: paymentMethod.card.exp_year
            }
        });
    } catch (err) {
        console.error('Save payment method error:', err);
        return error(err.message || 'Failed to save payment method', 400);
    }
}

async function toggleAutoPay(companyId, event) {
    const body = parseBody(event);
    const { enabled } = body;

    // Check if they have a payment method
    const companyResult = await query('SELECT payment_method_id FROM companies WHERE id = $1', [companyId]);
    
    if (enabled && !companyResult.rows[0]?.payment_method_id) {
        return error('Please add a payment method first', 400);
    }

    await query('UPDATE companies SET auto_pay = $1 WHERE id = $2', [enabled, companyId]);

    return success({ 
        message: enabled ? 'Auto-pay enabled' : 'Auto-pay disabled',
        auto_pay: enabled
    });
}

async function removePaymentMethod(companyId) {
    if (!STRIPE_SECRET_KEY) {
        return error('Stripe not configured', 400);
    }

    const stripe = require('stripe')(STRIPE_SECRET_KEY);

    const companyResult = await query('SELECT payment_method_id, stripe_customer_id FROM companies WHERE id = $1', [companyId]);
    const company = companyResult.rows[0];

    if (company.payment_method_id) {
        try {
            // Detach from Stripe
            await stripe.paymentMethods.detach(company.payment_method_id);
        } catch (err) {
            console.log('Error detaching payment method:', err.message);
        }
    }

    // Remove from database
    await query(`
        UPDATE companies 
        SET payment_method_id = NULL, auto_pay = false 
        WHERE id = $1
    `, [companyId]);

    return success({ message: 'Payment method removed' });
}

async function payInvoiceNow(companyId, invoiceId) {
    if (!STRIPE_SECRET_KEY) {
        return error('Online payments not configured', 400);
    }

    // Get invoice
    const invoiceResult = await query(`
        SELECT * FROM invoices WHERE id = $1 AND company_id = $2 AND status = 'pending'
    `, [invoiceId, companyId]);

    if (invoiceResult.rows.length === 0) {
        return error('Invoice not found or already paid', 404);
    }

    const invoice = invoiceResult.rows[0];

    // Get company
    const companyResult = await query(`
        SELECT * FROM companies WHERE id = $1
    `, [companyId]);
    const company = companyResult.rows[0];

    if (!company.payment_method_id || !company.stripe_customer_id) {
        return error('No payment method on file', 400);
    }

    const stripe = require('stripe')(STRIPE_SECRET_KEY);

    try {
        // Create and confirm payment intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(invoice.total * 100),
            currency: 'usd',
            customer: company.stripe_customer_id,
            payment_method: company.payment_method_id,
            off_session: true,
            confirm: true,
            metadata: {
                invoice_id: invoiceId,
                invoice_number: invoice.invoice_number,
                company_id: companyId
            },
            description: `Invoice ${invoice.invoice_number}`
        });

        if (paymentIntent.status === 'succeeded') {
            // Record payment
            const paymentResult = await query(`
                INSERT INTO payments (company_id, invoice_id, amount, payment_method, transaction_id, status, description)
                VALUES ($1, $2, $3, 'card', $4, 'completed', 'Online payment')
                RETURNING *
            `, [companyId, invoiceId, invoice.total, paymentIntent.id]);

            const payment = paymentResult.rows[0];

            // Update invoice
            await query(`
                UPDATE invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = $1
            `, [invoiceId]);

            // Update ledger
            const balanceResult = await query('SELECT balance FROM companies WHERE id = $1', [companyId]);
            const currentBalance = parseFloat(balanceResult.rows[0]?.balance) || 0;
            const newBalance = currentBalance - parseFloat(invoice.total);

            await query(`
                INSERT INTO billing_ledger (company_id, type, amount, balance, description, reference_type, reference_id, created_by_type)
                VALUES ($1, 'payment', $2, $3, $4, 'payment', $5, 'stripe')
            `, [companyId, -invoice.total, newBalance, `Payment for ${invoice.invoice_number}`, payment.id]);

            await query('UPDATE companies SET balance = $1 WHERE id = $2', [newBalance, companyId]);

            // Send receipt email
            await sendInvoiceEmail(invoice, company, payment);

            return success({ 
                message: 'Payment successful',
                payment: payment
            });
        } else {
            return error(`Payment failed: ${paymentIntent.status}`, 400);
        }
    } catch (err) {
        console.error('Payment error:', err);
        return error(err.message || 'Payment failed', 400);
    }
}
