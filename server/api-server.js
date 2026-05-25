/**
 * FoodBF OTP API Server — Standalone
 *
 * Variables d'environnement requises :
 *   PORT                      → port d'écoute (défaut : 3000)
 *   RESEND_API_KEY             → clé API Resend
 *   FIREBASE_SERVICE_ACCOUNT   → contenu JSON du service account (stringify)
 *
 * Déploiement : Railway / Render / Fly.io / VPS
 *   npm install && npm start
 */

const express = require("express");
const cors    = require("cors");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth }      = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { Resend }       = require("resend");

// ─── Firebase Admin init ──────────────────────────────────────────────────────
if (getApps().length === 0) {
  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Railway / production : env var JSON
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    credential = cert(sa);
    console.log("✅ Firebase initialisé via FIREBASE_SERVICE_ACCOUNT env var");
  } else {
    // Fallback local : fichier JSON
    try {
      const serviceAccount = require("./service-account.json");
      credential = cert(serviceAccount);
      console.log("✅ Firebase initialisé via service-account.json");
    } catch {
      console.error("❌ FIREBASE_SERVICE_ACCOUNT manquant et service-account.json introuvable");
      process.exit(1);
    }
  }

  initializeApp({ credential });
}

const adminAuth = getAuth();
const db        = getFirestore();
const resend    = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function emailTemplate(otp) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Votre code FoodBF</title></head>
<body style="margin:0;padding:0;background:#F4F9F4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F9F4;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:#1B6B35;padding:28px 40px;text-align:center;">
          <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:900;letter-spacing:-0.5px;">🍔 FoodBF Dodo</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:13px;">Livraison de repas au Burkina Faso</p>
        </td></tr>
        <tr><td style="padding:40px;">
          <p style="margin:0 0 8px;color:#555;font-size:15px;">Votre code de vérification :</p>
          <div style="background:#F0FDF4;border:2px solid #2D6A4F;border-radius:16px;padding:28px;text-align:center;margin:20px 0;">
            <span style="font-size:52px;font-weight:900;letter-spacing:14px;color:#1B6B35;font-family:'Courier New',monospace;">${otp}</span>
          </div>
          <p style="margin:0 0 6px;color:#666;font-size:14px;line-height:1.6;">Ce code est valable <strong>10 minutes</strong>.</p>
          <p style="margin:0;color:#999;font-size:13px;">Ne partagez jamais ce code avec quelqu'un d'autre.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:28px 0;">
          <p style="margin:0;color:#bbb;font-size:12px;text-align:center;">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Email invalide." });
    }

    const emailLower = email.toLowerCase().trim();
    const otpRef     = db.collection("otp_codes").doc(emailLower);
    const existing   = await otpRef.get();

    if (existing.exists) {
      const data       = existing.data();
      const createdAt  = data.createdAt?.toDate() ?? new Date(0);
      const minutesAgo = (Date.now() - createdAt.getTime()) / 60000;
      if (minutesAgo < 1 && (data.sendCount ?? 0) >= 3) {
        return res.status(429).json({ ok: false, error: "Trop de tentatives. Attendez 1 minute avant de réessayer." });
      }
    }

    const otp       = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const sendCount = existing.exists ? ((existing.data().sendCount ?? 0) + 1) : 1;

    await otpRef.set({
      email: emailLower,
      code: otp,
      expiresAt: Timestamp.fromDate(expiresAt),
      attempts: 0,
      sendCount,
      createdAt: Timestamp.now(),
    });

    const { error: sendError } = await resend.emails.send({
      from:    "FoodBF Dodo <onboarding@resend.dev>",
      to:      emailLower,
      subject: `${otp} — Votre code de connexion FoodBF`,
      html:    emailTemplate(otp),
    });

    if (sendError) {
      const isDomainRestriction =
        sendError.statusCode === 403 ||
        (sendError.message && sendError.message.includes("only send testing emails"));

      if (isDomainRestriction) {
        console.log(`\n🔑 OTP [DEV MODE] ──────────────────────────`);
        console.log(`   Email : ${emailLower}`);
        console.log(`   Code  : ${otp}`);
        console.log(`   (Domaine non vérifié sur Resend — visible dans les logs Railway)`);
        console.log(`────────────────────────────────────────────\n`);
      } else {
        console.error("Resend error:", sendError);
        return res.status(500).json({ ok: false, error: "Erreur d'envoi d'email. Réessayez." });
      }
    } else {
      console.log(`OTP envoyé à ${emailLower}`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("send-otp error:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur. Réessayez." });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ ok: false, error: "Email et code requis." });
    }

    const emailLower = email.toLowerCase().trim();
    const otpRef     = db.collection("otp_codes").doc(emailLower);
    const snap       = await otpRef.get();

    if (!snap.exists) {
      return res.status(400).json({ ok: false, error: "Aucun code trouvé. Demandez un nouveau code." });
    }

    const data      = snap.data();
    const expiresAt = data.expiresAt?.toDate() ?? new Date(0);

    if (Date.now() > expiresAt.getTime()) {
      await otpRef.delete();
      return res.status(400).json({ ok: false, error: "Code expiré. Demandez un nouveau code." });
    }

    if ((data.attempts ?? 0) >= 5) {
      await otpRef.delete();
      return res.status(429).json({ ok: false, error: "Trop de tentatives. Demandez un nouveau code." });
    }

    if (data.code !== code.trim()) {
      const newAttempts = (data.attempts ?? 0) + 1;
      await otpRef.update({ attempts: newAttempts });
      const remaining = 5 - newAttempts;
      return res.status(400).json({
        ok: false,
        error: `Code incorrect. ${remaining} tentative${remaining > 1 ? "s" : ""} restante${remaining > 1 ? "s" : ""}.`,
      });
    }

    await otpRef.delete();

    let uid;
    let isNewUser = false;
    try {
      const userRecord = await adminAuth.getUserByEmail(emailLower);
      uid = userRecord.uid;
    } catch {
      const newUser = await adminAuth.createUser({ email: emailLower, emailVerified: true });
      uid      = newUser.uid;
      isNewUser = true;
    }

    const customToken = await adminAuth.createCustomToken(uid);
    console.log(`OTP vérifié pour ${emailLower}, isNewUser=${isNewUser}`);
    return res.json({ ok: true, customToken, uid, isNewUser });
  } catch (err) {
    console.error("verify-otp error:", err);
    return res.status(500).json({ ok: false, error: "Erreur serveur. Réessayez." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "FoodBF OTP API", timestamp: new Date().toISOString() });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ FoodBF OTP API démarré sur port ${PORT}`);
  console.log(`   GET  /api/health`);
  console.log(`   POST /api/auth/send-otp`);
  console.log(`   POST /api/auth/verify-otp`);
});
