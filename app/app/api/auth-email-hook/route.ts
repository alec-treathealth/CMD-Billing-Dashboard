/**
 * POST /api/auth-email-hook — Supabase "Send Email" Auth Hook (HTTPS), implemented in THIS app's
 * Node/Next runtime (no Supabase Edge Function / Deno). When registered in Supabase → Authentication
 * → Hooks → Send Email, GoTrue POSTs the email payload here INSTEAD of using its built-in templating
 * + SMTP, and we render + send the mail ourselves via Resend. This fixes the template/SMTP bug class
 * (empty `{{ .Type }}`-style params, wrong link host) by building the link in code.
 *
 * It does NOT remove Resend's domain-verification requirement: with an unverified domain Resend only
 * delivers to the account owner's address, whether called via API (here) or SMTP. Verifying
 * treathealth.ai in Resend is separate, out-of-scope work.
 *
 * Security: the request is signed per the Standard Webhooks spec. We verify it against
 * SEND_EMAIL_HOOK_SECRET (the `v1,whsec_<base64>` value Supabase generates when the hook is
 * registered) using the `standardwebhooks` package, over the RAW request body. Unverified requests
 * are rejected 401.
 *
 * Observability: the ENTIRE handler is wrapped in a top-level try/catch that console.error's the full
 * error (message + stack) before returning any 500, and every Resend failure logs the HTTP status +
 * Resend's error body. We deliberately DO NOT log token / token_hash (single-use auth secrets). Resend
 * error bodies may include the sender/recipient address (staff identity, not patient PHI) — acceptable
 * for debugging this internal auth flow.
 *
 * Response contract (per Supabase HTTP hook docs):
 *   - success → 200, body `{}`, Content-Type application/json.
 *   - failure → JSON `{ error: { http_code, message } }`, Content-Type application/json.
 *     GoTrue treats 400/403 as 500; 429/503 are the only retry-able codes (need a `retry-after`).
 */
import { Webhook } from 'standardwebhooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Verified payload subset we use. GoTrue sends much more (see docs); we read only these fields. */
interface HookPayload {
  user: { email: string; new_email?: string };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: string;
    site_url: string;
    token_new?: string;
    token_hash_new?: string;
  };
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Sender. Until treathealth.ai is verified in Resend, this must be Resend's shared sender and mail
 *  only reaches the account owner. Override via RESEND_FROM once the domain is verified. */
const DEFAULT_FROM = 'TreatHealthOS <onboarding@resend.dev>';

/** Post-verification destination for each action, matching app/app/auth/confirm/route.ts:
 *  invite + recovery land on /set-password; everything else defaults to /dashboard. */
function nextFor(actionType: string): string {
  return actionType === 'invite' || actionType === 'recovery' ? '/set-password' : '/dashboard';
}

/** Build the app's token-hash confirm URL (NOT GoTrue's /verify) — mirrors auth/confirm/route.ts. */
function confirmUrl(siteUrl: string, tokenHash: string, actionType: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    token_hash: tokenHash,
    type: actionType,
    next: nextFor(actionType),
  });
  return `${base}/auth/confirm?${params.toString()}`;
}

function subjectFor(actionType: string): string {
  switch (actionType) {
    case 'invite':
      return "You're invited to TreatHealthOS";
    case 'recovery':
      return 'Reset your TreatHealthOS password';
    case 'magiclink':
      return 'Your TreatHealthOS sign-in link';
    case 'signup':
      return 'Confirm your TreatHealthOS account';
    case 'email_change':
      return 'Confirm your email change · TreatHealthOS';
    case 'reauthentication':
      return 'Your TreatHealthOS verification code';
    default:
      return 'TreatHealthOS';
  }
}

function introFor(actionType: string): string {
  switch (actionType) {
    case 'invite':
      return 'You’ve been invited to the TreatHealthOS billing &amp; RCM console. Click below to set your password and finish setting up your account.';
    case 'recovery':
      return 'We received a request to reset your password. Click below to choose a new one. If you didn’t request this, you can ignore this email.';
    case 'magiclink':
      return 'Click below to sign in to TreatHealthOS. If you didn’t request this, you can ignore this email.';
    case 'signup':
      return 'Confirm your email address to activate your TreatHealthOS account.';
    case 'email_change':
      return 'Confirm this email address to complete your email change on TreatHealthOS.';
    default:
      return 'Continue to TreatHealthOS.';
  }
}

function ctaLabelFor(actionType: string): string {
  switch (actionType) {
    case 'invite':
      return 'Set your password';
    case 'recovery':
      return 'Reset password';
    case 'magiclink':
      return 'Sign in';
    default:
      return 'Confirm';
  }
}

/** Minimal, email-client-safe (inline-styled) branded template. TreatHealthOS teal (#1C8B82). */
function renderActionEmail(opts: { subject: string; intro: string; ctaLabel: string; ctaUrl: string }): string {
  const { subject, intro, ctaLabel, ctaUrl } = opts;
  return `<!doctype html>
<html><body style="margin:0;background:#f4f6f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f2a29;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e2e8e7;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#1C8B82;padding:18px 24px;">
          <div style="font-size:16px;font-weight:700;color:#ffffff;letter-spacing:-0.2px;">TreatHealthOS</div>
          <div style="font-size:9px;font-weight:600;letter-spacing:1.5px;color:rgba(255,255,255,0.75);margin-top:2px;">POWERED BY TREAT HEALTH AI · BILLING &amp; RCM</div>
        </td></tr>
        <tr><td style="padding:28px 24px;">
          <h1 style="margin:0 0 12px;font-size:18px;font-weight:600;">${subject}</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#334e4c;">${intro}</p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#1C8B82;">
            <a href="${ctaUrl}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${ctaLabel}</a>
          </td></tr></table>
          <p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#66807e;">Or paste this link into your browser:<br/>
            <a href="${ctaUrl}" style="color:#1C8B82;word-break:break-all;">${ctaUrl}</a></p>
          <p style="margin:16px 0 0;font-size:11px;color:#8aa19f;">This link handles PHI-adjacent access and is single-use. Every access is audited.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Reauthentication has no link — the user types a code back into the app. Show the code. */
function renderCodeEmail(code: string): string {
  return `<!doctype html>
<html><body style="margin:0;background:#f4f6f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f2a29;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f6;padding:24px 0;"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #e2e8e7;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#1C8B82;padding:18px 24px;">
        <div style="font-size:16px;font-weight:700;color:#fff;">TreatHealthOS</div>
        <div style="font-size:9px;font-weight:600;letter-spacing:1.5px;color:rgba(255,255,255,0.75);margin-top:2px;">POWERED BY TREAT HEALTH AI · BILLING &amp; RCM</div>
      </td></tr>
      <tr><td style="padding:28px 24px;">
        <h1 style="margin:0 0 12px;font-size:18px;font-weight:600;">Your verification code</h1>
        <p style="margin:0 0 16px;font-size:14px;color:#334e4c;">Enter this code to confirm it’s you. If you didn’t request it, you can ignore this email.</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;color:#1C8B82;">${code}</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

/** JSON error in Supabase's hook error shape. 400/403 → GoTrue treats as 500; 429/503 are retry-able. */
function hookError(httpCode: number, message: string, status: number, retryable = false): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryable) headers['retry-after'] = '5';
  return new Response(JSON.stringify({ error: { http_code: httpCode, message } }), { status, headers });
}

/** Send one email via Resend's REST API (no SDK). Returns ok + the HTTP status + the response body
 *  (so failures can be logged with Resend's actual reason). */
async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, status: 0, body: 'missing RESEND_API_KEY' };
  const from = process.env.RESEND_FROM || DEFAULT_FROM;
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  const body = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body };
}

/** Send + log. Logs Resend's HTTP status and error body on failure (may name sender/recipient — staff
 *  identity, not patient PHI); never logs token/token_hash. Returns whether the send succeeded. */
async function sendLogged(to: string, subject: string, html: string, type: string): Promise<boolean> {
  const r = await sendEmail(to, subject, html);
  if (!r.ok) {
    console.error(`[auth-email-hook] Resend send FAILED type=${type} status=${r.status} body=${r.body}`);
    return false;
  }
  console.log(`[auth-email-hook] Resend send OK type=${type} status=${r.status}`);
  return true;
}

export async function POST(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return hookError(405, 'Method not allowed', 405);

    const secret = process.env.SEND_EMAIL_HOOK_SECRET;
    const resendKey = process.env.RESEND_API_KEY;
    if (!secret || !resendKey) {
      console.error(
        `[auth-email-hook] misconfigured: SEND_EMAIL_HOOK_SECRET=${secret ? 'set' : 'MISSING'} RESEND_API_KEY=${resendKey ? 'set' : 'MISSING'}`,
      );
      return hookError(500, 'Email hook is not configured', 500);
    }

    // Standard Webhooks: verify over the RAW body. Supabase stores the secret as `v1,whsec_<base64>`;
    // the library takes the base64 portion.
    const raw = await req.text();
    const headers = Object.fromEntries(req.headers);
    let payload: HookPayload;
    try {
      const wh = new Webhook(secret.replace(/^v1,whsec_/, ''));
      payload = wh.verify(raw, headers) as HookPayload;
    } catch (err) {
      console.error('[auth-email-hook] signature verification failed:', err);
      return hookError(401, 'Invalid signature', 401);
    }

    const { user, email_data } = payload;
    const type = email_data.email_action_type;
    console.log(`[auth-email-hook] verified request type=${type}`);

    if (type === 'reauthentication') {
      // No link — send the OTP code.
      if (!(await sendLogged(user.email, subjectFor(type), renderCodeEmail(email_data.token), type))) {
        return hookError(500, 'Failed to send email', 500);
      }
    } else if (type === 'email_change') {
      // Secure Email Change (both token/hash pairs present) → two emails. NOTE the docs' REVERSED
      // field mapping: current email uses token_hash_new; new email uses token_hash.
      const secure = Boolean(email_data.token_hash_new) && Boolean(user.new_email);
      if (secure) {
        const toCurrent = confirmUrl(email_data.site_url, email_data.token_hash_new!, type);
        const toNew = confirmUrl(email_data.site_url, email_data.token_hash, type);
        const a = await sendLogged(user.email, subjectFor(type), renderActionEmail({ subject: subjectFor(type), intro: introFor(type), ctaLabel: ctaLabelFor(type), ctaUrl: toCurrent }), type);
        const b = await sendLogged(user.new_email!, subjectFor(type), renderActionEmail({ subject: subjectFor(type), intro: introFor(type), ctaLabel: ctaLabelFor(type), ctaUrl: toNew }), type);
        if (!a || !b) return hookError(500, 'Failed to send email', 500);
      } else {
        const to = user.new_email || user.email;
        const url = confirmUrl(email_data.site_url, email_data.token_hash, type);
        if (!(await sendLogged(to, subjectFor(type), renderActionEmail({ subject: subjectFor(type), intro: introFor(type), ctaLabel: ctaLabelFor(type), ctaUrl: url }), type))) {
          return hookError(500, 'Failed to send email', 500);
        }
      }
    } else {
      // Link-based: invite | recovery | magiclink | signup (+ safe default).
      const url = confirmUrl(email_data.site_url, email_data.token_hash, type);
      if (!(await sendLogged(user.email, subjectFor(type), renderActionEmail({ subject: subjectFor(type), intro: introFor(type), ctaLabel: ctaLabelFor(type), ctaUrl: url }), type))) {
        return hookError(500, 'Failed to send email', 500);
      }
    }

    // Success: empty JSON object, 200, application/json.
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    // Anything that threw before/outside the branches above (body read, header parse, JSON, etc.)
    // — previously an UNLOGGED 500. Now logged with the full error + stack.
    console.error('[auth-email-hook] unhandled error:', err);
    return hookError(500, 'Internal error', 500);
  }
}
