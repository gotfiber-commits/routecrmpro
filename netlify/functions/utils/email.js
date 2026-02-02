// Email utility using Resend
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'billing@routecrmpro.com';
const COMPANY_NAME = 'RouteCRMPro';

async function sendEmail({ to, subject, html, text }) {
    if (!RESEND_API_KEY) {
        console.log('Email not configured - RESEND_API_KEY missing');
        console.log('Would send to:', to, 'Subject:', subject);
        return { success: false, error: 'Email not configured' };
    }

    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: `${COMPANY_NAME} <${FROM_EMAIL}>`,
                to: Array.isArray(to) ? to : [to],
                subject,
                html,
                text
            })
        });

        const data = await response.json();
        
        if (response.ok) {
            return { success: true, id: data.id };
        } else {
            console.error('Email send failed:', data);
            return { success: false, error: data.message || 'Failed to send email' };
        }
    } catch (err) {
        console.error('Email error:', err);
        return { success: false, error: err.message };
    }
}

function generateInvoiceEmailHtml(invoice, company, payment = null) {
    const isPaid = invoice.status === 'paid' || payment;
    const statusColor = isPaid ? '#10B981' : '#F59E0B';
    const statusText = isPaid ? 'PAID' : 'DUE';
    
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f5;">
    <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">🚛 RouteCRMPro</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 10px 0 0;">Invoice ${invoice.invoice_number}</p>
        </div>
        
        <!-- Status Banner -->
        <div style="background: ${statusColor}; color: white; padding: 15px; text-align: center; font-weight: bold; font-size: 18px;">
            ${statusText}${isPaid && payment ? ` - Thank you for your payment!` : ''}
        </div>
        
        <!-- Invoice Body -->
        <div style="background: white; padding: 30px; border: 1px solid #e4e4e7;">
            <!-- Company Info -->
            <div style="margin-bottom: 30px;">
                <p style="color: #71717a; margin: 0 0 5px; font-size: 14px;">Bill To:</p>
                <p style="margin: 0; font-size: 18px; font-weight: 600; color: #18181b;">${company.name}</p>
                <p style="margin: 5px 0 0; color: #71717a;">${company.email}</p>
            </div>
            
            <!-- Invoice Details -->
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                <tr>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Invoice Number</td>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; text-align: right; font-weight: 600;">${invoice.invoice_number}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Invoice Date</td>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; text-align: right;">${new Date(invoice.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Billing Period</td>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; text-align: right;">${new Date(invoice.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date(invoice.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                </tr>
                ${!isPaid ? `
                <tr>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Due Date</td>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; text-align: right; color: #F59E0B; font-weight: 600;">${new Date(invoice.due_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</td>
                </tr>
                ` : ''}
                ${isPaid && payment ? `
                <tr>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Payment Date</td>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; text-align: right; color: #10B981;">${new Date(payment.created_at || invoice.paid_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; color: #71717a;">Payment Method</td>
                    <td style="padding: 10px 0; border-bottom: 1px solid #e4e4e7; text-align: right;">${payment.payment_method === 'card' ? '💳 Card' : payment.payment_method || 'Auto-pay'}</td>
                </tr>
                ` : ''}
            </table>
            
            <!-- Line Items -->
            <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 10px 0; font-weight: 600;">Description</td>
                        <td style="padding: 10px 0; text-align: right; font-weight: 600;">Amount</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 0; border-top: 1px solid #e4e4e7;">
                            <strong style="text-transform: capitalize;">${invoice.plan} Plan</strong> - Monthly Subscription
                            <br><span style="color: #71717a; font-size: 14px;">${invoice.notes || 'RouteCRMPro SaaS Platform'}</span>
                        </td>
                        <td style="padding: 10px 0; border-top: 1px solid #e4e4e7; text-align: right;">$${parseFloat(invoice.amount).toFixed(2)}</td>
                    </tr>
                    ${invoice.tax > 0 ? `
                    <tr>
                        <td style="padding: 10px 0; border-top: 1px solid #e4e4e7;">Tax</td>
                        <td style="padding: 10px 0; border-top: 1px solid #e4e4e7; text-align: right;">$${parseFloat(invoice.tax).toFixed(2)}</td>
                    </tr>
                    ` : ''}
                </table>
            </div>
            
            <!-- Total -->
            <div style="text-align: right; padding: 20px; background: ${isPaid ? '#10B981' : '#6366F1'}; border-radius: 8px; color: white;">
                <span style="font-size: 14px;">Total ${isPaid ? 'Paid' : 'Due'}</span>
                <div style="font-size: 32px; font-weight: 700;">$${parseFloat(invoice.total).toFixed(2)}</div>
            </div>
        </div>
        
        <!-- Footer -->
        <div style="padding: 30px; text-align: center; color: #71717a; font-size: 14px;">
            ${isPaid ? `
            <p style="margin: 0 0 15px;">This invoice has been paid. Thank you for your business!</p>
            ` : `
            <p style="margin: 0 0 15px;">Please pay by the due date to avoid service interruption.</p>
            <a href="https://www.routecrmpro.com/app?tenant=${company.subdomain}" style="display: inline-block; background: #6366F1; color: white; padding: 12px 30px; border-radius: 8px; text-decoration: none; font-weight: 600;">View Invoice & Pay</a>
            `}
            <p style="margin: 30px 0 0; color: #a1a1aa;">
                RouteCRMPro • Propane & Fuel Delivery Management<br>
                Questions? Contact billing@routecrmpro.com
            </p>
        </div>
    </div>
</body>
</html>
    `;
}

function generateInvoiceEmailText(invoice, company, payment = null) {
    const isPaid = invoice.status === 'paid' || payment;
    
    return `
RouteCRMPro Invoice ${invoice.invoice_number}
${'='.repeat(50)}

Status: ${isPaid ? 'PAID' : 'DUE'}

Bill To: ${company.name}
Email: ${company.email}

Invoice Details:
- Invoice Number: ${invoice.invoice_number}
- Invoice Date: ${new Date(invoice.created_at).toLocaleDateString()}
- Billing Period: ${new Date(invoice.period_start).toLocaleDateString()} - ${new Date(invoice.period_end).toLocaleDateString()}
${!isPaid ? `- Due Date: ${new Date(invoice.due_date).toLocaleDateString()}` : ''}
${isPaid && payment ? `- Payment Date: ${new Date(payment.created_at || invoice.paid_at).toLocaleDateString()}` : ''}

Description: ${invoice.plan} Plan - Monthly Subscription
Amount: $${parseFloat(invoice.amount).toFixed(2)}
${invoice.tax > 0 ? `Tax: $${parseFloat(invoice.tax).toFixed(2)}` : ''}

TOTAL ${isPaid ? 'PAID' : 'DUE'}: $${parseFloat(invoice.total).toFixed(2)}

${isPaid ? 'This invoice has been paid. Thank you for your business!' : 'Please pay by the due date to avoid service interruption.'}

View your account: https://www.routecrmpro.com/app?tenant=${company.subdomain}

Questions? Contact billing@routecrmpro.com
    `.trim();
}

async function sendInvoiceEmail(invoice, company, payment = null) {
    const isPaid = invoice.status === 'paid' || payment;
    const subject = isPaid 
        ? `Payment Receipt - Invoice ${invoice.invoice_number}` 
        : `Invoice ${invoice.invoice_number} - $${parseFloat(invoice.total).toFixed(2)} Due`;
    
    const toEmail = company.billing_email || company.email;
    
    return await sendEmail({
        to: toEmail,
        subject,
        html: generateInvoiceEmailHtml(invoice, company, payment),
        text: generateInvoiceEmailText(invoice, company, payment)
    });
}

async function sendPaymentFailedEmail(invoice, company, errorMessage) {
    const subject = `⚠️ Payment Failed - Invoice ${invoice.invoice_number}`;
    
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f5;">
    <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <div style="background: #EF4444; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0;">⚠️ Payment Failed</h1>
        </div>
        <div style="background: white; padding: 30px; border: 1px solid #e4e4e7; border-radius: 0 0 12px 12px;">
            <p>Hi ${company.name},</p>
            <p>We were unable to process your automatic payment for invoice <strong>${invoice.invoice_number}</strong>.</p>
            <p><strong>Amount:</strong> $${parseFloat(invoice.total).toFixed(2)}</p>
            <p><strong>Reason:</strong> ${errorMessage || 'Payment declined'}</p>
            <p>Please update your payment method or pay manually to avoid service interruption.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="https://www.routecrmpro.com/app?tenant=${company.subdomain}" style="display: inline-block; background: #6366F1; color: white; padding: 12px 30px; border-radius: 8px; text-decoration: none; font-weight: 600;">Update Payment Method</a>
            </div>
            <p style="color: #71717a; font-size: 14px;">Questions? Contact billing@routecrmpro.com</p>
        </div>
    </div>
</body>
</html>
    `;

    return await sendEmail({
        to: company.billing_email || company.email,
        subject,
        html,
        text: `Payment Failed for Invoice ${invoice.invoice_number}. Amount: $${invoice.total}. Reason: ${errorMessage}. Please update your payment method at https://www.routecrmpro.com/app?tenant=${company.subdomain}`
    });
}

module.exports = {
    sendEmail,
    sendInvoiceEmail,
    sendPaymentFailedEmail,
    generateInvoiceEmailHtml
};
