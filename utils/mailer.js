// Sends email through SMTP when SMTP_HOST is configured. Without it, sending is
// skipped and callers fall back to showing the link in the UI.
const nodemailer = require('nodemailer');

let transport;

const isMailConfigured = () => Boolean(process.env.SMTP_HOST);

const getTransport = () => {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return transport;
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

// Returns true when the email was handed to the SMTP server.
const sendInvitationEmail = async ({ to, organizationName, inviterName, inviteUrl }) => {
  if (!isMailConfigured()) {
    return false;
  }

  await getTransport().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `You're invited to join ${organizationName} on OAuth Server`,
    text: `${inviterName} invited you to join ${organizationName} on OAuth Server.\n\n`
      + `Accept the invitation: ${inviteUrl}\n\nThis link expires in 7 days.`,
    html: `<p>${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(organizationName)}</strong> on OAuth Server.</p>`
      + `<p><a href="${escapeHtml(inviteUrl)}">Accept the invitation</a></p>`
      + '<p>This link expires in 7 days.</p>',
  });
  return true;
};

module.exports = { isMailConfigured, sendInvitationEmail };
