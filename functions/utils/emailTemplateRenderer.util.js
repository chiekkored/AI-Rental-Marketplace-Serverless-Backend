const BRAND_COLOR = "#ff6b00";
const DEFAULT_WEB_BASE_URL = "https://getlend.dev";
const LOGO_PATH = "/logo.png";
const HELP_CENTER_PATH = "/help-center";
const TERMS_PATH = "/terms-and-conditions";
const PRIVACY_PATH = "/privacy-policy";

function renderTransactionalEmail({
  action,
  details = [],
  greetingName,
  intro,
  notice,
  preheader,
  title,
}) {
  const greeting = greetingName ? `Hi ${greetingName},` : "Hi there,";
  const logoUrl = buildLogoUrl();
  const helpCenterUrl = buildWebUrl(HELP_CENTER_PATH);
  const termsUrl = buildWebUrl(TERMS_PATH);
  const privacyUrl = buildWebUrl(PRIVACY_PATH);
  const safeDetails = details.filter((item) => item?.label && item?.value);
  const textLines = [greeting, "", intro];

  if (safeDetails.length) {
    textLines.push("", ...safeDetails.map(({ label, value }) => `${label}: ${value}`));
  }
  if (action?.label && action?.url) {
    textLines.push("", `${action.label}:`, action.url);
  }
  if (notice) textLines.push("", notice);
  textLines.push(
    "",
    "You cannot reply to this email address. If you have any questions, visit our Help Center:",
    helpCenterUrl,
    "",
    `Terms: ${termsUrl}`,
    `Privacy: ${privacyUrl}`,
    "© 2026 Lend. All rights reserved.",
  );

  const detailRows = safeDetails
    .map(
      ({ label, value }) => `
        <tr>
          <td style="padding:8px 16px 8px 0;color:#6b7280;font-size:14px;line-height:20px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:8px 0;color:#111827;font-size:14px;line-height:20px;text-align:right;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");

  const detailsHtml = detailRows
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:24px 0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">${detailRows}</table>`
    : "";
  const actionHtml = action?.label && action?.url
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 12px;"><tr><td bgcolor="${BRAND_COLOR}" style="border-radius:6px;"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:13px 20px;color:#ffffff;font-size:15px;font-weight:700;line-height:20px;text-decoration:none;">${escapeHtml(action.label)}</a></td></tr></table><p style="margin:0;color:#6b7280;font-size:12px;line-height:18px;word-break:break-all;">If the button does not work, open:<br><a href="${escapeHtml(action.url)}" style="color:#4b5563;text-decoration:underline;">${escapeHtml(action.url)}</a></p>`
    : "";
  const noticeHtml = notice
    ? `<p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px;line-height:20px;">${escapeHtml(notice)}</p>`
    : "";
  const footerHtml = `<p style="margin:0 0 12px;color:#6b7280;font-size:12px;line-height:18px;">You cannot reply to this email address. If you have any questions, visit our <a href="${escapeHtml(helpCenterUrl)}" style="color:#4b5563;text-decoration:underline;">Help Center</a>.</p><p style="margin:0 0 12px;color:#6b7280;font-size:12px;line-height:18px;"><a href="${escapeHtml(termsUrl)}" style="color:#4b5563;text-decoration:underline;">Terms</a><span style="color:#d1d5db;">&nbsp;&nbsp;|&nbsp;&nbsp;</span><a href="${escapeHtml(privacyUrl)}" style="color:#4b5563;text-decoration:underline;">Privacy</a></p><p style="margin:0;color:#9ca3af;font-size:12px;line-height:18px;">© 2026 Lend. All rights reserved.</p>`;

  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;padding:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#111827;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || intro)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;"><tr><td align="center" style="padding:32px 16px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;"><tr><td style="padding:24px 32px 16px;border-bottom:1px solid #e5e7eb;"><img src="${escapeHtml(logoUrl)}" alt="Lend" width="96" style="display:block;width:96px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;"></td></tr><tr><td style="padding:32px;"><h1 style="margin:0 0 20px;color:#111827;font-size:26px;line-height:34px;font-weight:750;letter-spacing:0;">${escapeHtml(title)}</h1><p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:24px;">${escapeHtml(greeting)}</p><p style="margin:0;color:#374151;font-size:15px;line-height:24px;">${escapeHtml(intro)}</p>${detailsHtml}${actionHtml}${noticeHtml}</td></tr><tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #e5e7eb;">${footerHtml}</td></tr></table></td></tr></table></body></html>`,
    text: textLines.join("\n"),
  };
}

function buildLogoUrl(env = process.env) {
  return buildWebUrl(LOGO_PATH, env);
}

function buildWebUrl(path, env = process.env) {
  const baseUrl = String(env.LEND_WEB_BASE_URL || DEFAULT_WEB_BASE_URL).trim().replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { renderTransactionalEmail, _test: { buildLogoUrl, buildWebUrl, escapeHtml } };
