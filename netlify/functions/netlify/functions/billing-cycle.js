// Scheduled Billing Cycle - Runs daily to process auto-payments
// Configure in netlify.toml with: [functions."billing-cycle"] schedule = "0 6 * * *"

const { query } = require('./utils/db');
const { sendInvoiceEmail, sendPaymentFailedEmail } = require('./utils/email');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

exports.handler = async (event, context) => {
    // This can be triggered by:
    // 1. Netlify scheduled function (daily)
    // 2. Manual POST request from super admin

    console.log('Starting billing cycle...');
    
    const results = {
        processed: 0,
        invoices_created: 0,
        payments_successful: 0,
        payments_failed: 0,
        emails_sent: 0,
        errors: []
    };

    try {
        // Get all active companies with auto_pay enabled
        const companies = await query(`
            SELECT c.*, pp.monthly_price
            FROM companies c
            JOIN plan_pricing pp ON c.plan = pp.plan
            WHERE c.status = 'active' 
            AND c.auto_pay = true 
            AND c.payment_method_id IS NOT NULL
            AND c.plan != 'trial'
            AND pp.monthly_price > 0
        `);

        console.log(`Found ${companies.rows.length} companies with auto-pay enabled`);

        for (const company of companies.rows) {
            try {
                results.processed++;
                
                // Check if company needs billing today
                // Bill on the same day each month as their signup (or 1st if not set)
                const billingDay = company.billing_day || 1;
                const today = new Date();
                
                if (today.getDate() !== billingDay) {
                    continue; // Not this company's billing day
                }

                // Check if already invoiced this month
                const existingInvoice = await query(`
                    SELECT id FROM invoices 
                    WHERE company_id = $1 
                    AND EXTRACT(MONTH FROM period_start) = EXTRACT(MONTH FROM CURRENT_DATE)
                    AND EXTRACT(YEAR FROM period_start) = EXTRACT(YEAR FROM CURRENT_DATE)
                `, [company.id]);

                if (existingInvoice.rows.length > 0) {
                    console.log(`Company ${company.name} already invoiced this month`);
                    continue;
                }

                console.log(`Processing billing for ${company.name}...`);

                // Create invoice
                const invoice = await createMonthlyInvoice(company);
                results.invoices_created++;

                // Attempt to charge
                const paymentResult = await processAutoPayment(company, invoice);

                if (paymentResult.success) {
                    results.payments_successful++;
                    
                    // Send paid invoice email
                    const emailResult = await sendInvoiceEmail(invoice, company, paymentResult.payment);
                    if (emailResult.success) {
                        results.emails_sent++;
                    }
                } else {
                    results.payments_failed++;
                    results.errors.push(`${company.name}: ${paymentResult.error}`);
                    
                    // Send payment failed email
                    await sendPaymentFailedEmail(invoice, company, paymentResult.error);
                }

            } catch (err) {
                console.error(`Error processing ${company.name}:`, err);
                results.errors.push(`${company.name}: ${err.message}`);
            }
        }

        // Also check for companies without auto-pay that need invoices
        await generatePendingInvoices(results);

        console.log('Billing cycle complete:', results);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Billing cycle complete',
                results
            })
        };

    } catch (err) {
        console.error('Billing cycle error:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};

async function createMonthlyInvoice(company) {
    // Calculate billing period
    const today = new Date();
    const periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const dueDate = new Date(today.getTime() + 15 * 24 * 60 * 60 * 1000); // 15 days from now

    // Generate invoice number
    const invoiceNumResult = await query('SELECT generate_invoice_number() as num');
    const invoiceNumber = invoiceNumResult.rows[0].num;

    const amount = parseFloat(company.monthly_price);
    const tax = 0; // Add tax calculation if needed
    const total = amount + tax;

    const result = await query(`
        INSERT INTO invoices (
            company_id, invoice_number, period_start, period_end, 
            plan, amount, tax, total, due_date, status, notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
        RETURNING *
    `, [
        company.id,
        invoiceNumber,
        periodStart.toISOString().split('T')[0],
        periodEnd.toISOString().split('T')[0],
        company.plan,
        amount,
        tax,
        total,
        dueDate.toISOString().split('T')[0],
        `Monthly subscription - ${company.plan} plan`
    ]);

    const invoice = result.rows[0];

    // Add to ledger
    await addLedgerEntry(
        company.id, 
        'charge', 
        total, 
        `Invoice ${invoiceNumber}`, 
        'invoice', 
        invoice.id, 
        'system', 
        null
    );

    return invoice;
}

async function processAutoPayment(company, invoice) {
    if (!STRIPE_SECRET_KEY) {
        return { success: false, error: 'Stripe not configured' };
    }

    if (!company.stripe_customer_id || !company.payment_method_id) {
        return { success: false, error: 'No payment method on file' };
    }

    try {
        const stripe = require('stripe')(STRIPE_SECRET_KEY);

        // Create payment intent and confirm immediately
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(invoice.total * 100), // Stripe uses cents
            currency: 'usd',
            customer: company.stripe_customer_id,
            payment_method: company.payment_method_id,
            off_session: true,
            confirm: true,
            metadata: {
                invoice_id: invoice.id,
                invoice_number: invoice.invoice_number,
                company_id: company.id
            },
            description: `Invoice ${invoice.invoice_number} - ${company.name}`
        });

        if (paymentIntent.status === 'succeeded') {
            // Record payment
            const paymentResult = await query(`
                INSERT INTO payments (
                    company_id, invoice_id, amount, payment_method, 
                    transaction_id, status, description
                )
                VALUES ($1, $2, $3, 'card', $4, 'completed', 'Auto-payment')
                RETURNING *
            `, [company.id, invoice.id, invoice.total, paymentIntent.id]);

            const payment = paymentResult.rows[0];

            // Update invoice status
            await query(`
                UPDATE invoices 
                SET status = 'paid', paid_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [invoice.id]);

            // Add payment to ledger
            await addLedgerEntry(
                company.id,
                'payment',
                -parseFloat(invoice.total),
                `Payment for ${invoice.invoice_number} (Auto-pay)`,
                'payment',
                payment.id,
                'stripe',
                null
            );

            return { success: true, payment };
        } else {
            return { success: false, error: `Payment status: ${paymentIntent.status}` };
        }

    } catch (err) {
        console.error('Stripe payment error:', err);
        
        // Handle specific Stripe errors
        if (err.code === 'card_declined') {
            return { success: false, error: 'Card declined' };
        } else if (err.code === 'expired_card') {
            return { success: false, error: 'Card expired' };
        } else if (err.code === 'insufficient_funds') {
            return { success: false, error: 'Insufficient funds' };
        }
        
        return { success: false, error: err.message };
    }
}

async function generatePendingInvoices(results) {
    // Get companies without auto-pay that need invoicing
    const companies = await query(`
        SELECT c.*, pp.monthly_price
        FROM companies c
        JOIN plan_pricing pp ON c.plan = pp.plan
        WHERE c.status = 'active' 
        AND (c.auto_pay = false OR c.auto_pay IS NULL OR c.payment_method_id IS NULL)
        AND c.plan != 'trial'
        AND pp.monthly_price > 0
    `);

    const today = new Date();
    
    for (const company of companies.rows) {
        try {
            const billingDay = company.billing_day || 1;
            
            if (today.getDate() !== billingDay) {
                continue;
            }

            // Check if already invoiced
            const existing = await query(`
                SELECT id FROM invoices 
                WHERE company_id = $1 
                AND EXTRACT(MONTH FROM period_start) = EXTRACT(MONTH FROM CURRENT_DATE)
                AND EXTRACT(YEAR FROM period_start) = EXTRACT(YEAR FROM CURRENT_DATE)
            `, [company.id]);

            if (existing.rows.length > 0) {
                continue;
            }

            // Create invoice (but don't auto-charge)
            const invoice = await createMonthlyInvoice(company);
            results.invoices_created++;

            // Send invoice due email
            const emailResult = await sendInvoiceEmail(invoice, company);
            if (emailResult.success) {
                results.emails_sent++;
            }

        } catch (err) {
            console.error(`Error creating invoice for ${company.name}:`, err);
            results.errors.push(`${company.name}: ${err.message}`);
        }
    }
}

async function addLedgerEntry(companyId, type, amount, description, refType, refId, createdByType, createdById) {
    const balanceResult = await query('SELECT balance FROM companies WHERE id = $1', [companyId]);
    const currentBalance = parseFloat(balanceResult.rows[0]?.balance) || 0;
    const newBalance = currentBalance + parseFloat(amount);

    await query(`
        INSERT INTO billing_ledger (company_id, type, amount, balance, description, reference_type, reference_id, created_by_type, created_by_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [companyId, type, amount, newBalance, description, refType, refId, createdByType, createdById]);

    await query('UPDATE companies SET balance = $1 WHERE id = $2', [newBalance, companyId]);
}
