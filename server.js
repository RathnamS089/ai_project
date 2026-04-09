const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const mysql = require("mysql2/promise");
const pdf = require("pdf-parse");
require("dotenv").config();
const nodemailer = require("nodemailer");
const PDFDocument = require('pdfkit');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_USER ? 'smtp.gmail.com' : 'smtp.ethereal.email',
  port: process.env.EMAIL_USER ? 465 : 587,
  secure: process.env.EMAIL_USER ? true : false,
  auth: {
    user: process.env.EMAIL_USER || 'karlie.kulas63@ethereal.email',
    pass: process.env.EMAIL_PASS || 'MwWq9aUQQeS6Z2sRw9'
  }
});

// Verify connectivity on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Email Connectivity Error:", error.message);
    if (process.env.EMAIL_USER) console.warn("💡 Tip: Ensure your App Password is correct and has no spaces.");
  } else {
    console.log("📧 Email Server ready to dispatch reports! ✅");
  }
});

const { getTutorResponse, generateQuizFromText, generateFlashcards, getAIStudyAdvice } = require("./aiService");
const { getGeminiResponse, generateQuizFromFiles } = require("./geminiService");
const { OAuth2Client } = require("google-auth-library");

const app = express();
const googleClient = new OAuth2Client("66198409645-et081tedgqpqgpdorlicvauuhcf089o2.apps.googleusercontent.com");

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// ── MySQL Config ─────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "adaptive_learning",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Verify Database Connection on startup
pool.query('SELECT 1').then(() => {
  console.log("Database connected successfully! 🗄️ ✅");
}).catch(err => {
  console.error("❌ Database Connection Error:", err.message);
  console.warn("💡 Tip: Ensure MySQL is running and your DB_USER/DB_PASS in .env are correct.");
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "templates", "code.html"));
});

app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(__dirname, "static", "favicon.ico"));
});

// ── REGISTER ─────────────────────────────────────────────────────────────────
app.post("/register", async (req, res) => {
  const { name = "", email = "", password = "", department = "", semester = 1 } = req.body;

  if (!name.trim() || !email.trim() || !password) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }

  const pwHash = hashPassword(password);

  try {
    const [result] = await pool.execute(
      "INSERT INTO students (name, email, password_hash, department, semester) VALUES (?, ?, ?, ?, ?)",
      [name.trim(), email.trim(), pwHash, department, semester]
    );
    return res.status(201).json({
      message: "Registered successfully",
      student_id: result.insertId,
    });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Email already registered" });
    }
    return res.status(500).json({ error: e.message });
  }
});

// ── LOGIN ────────────────────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { email = "", password = "" } = req.body;
  const pwHash = hashPassword(password);

  try {
    const [rows] = await pool.execute(
      "SELECT student_id, name, email, department, semester FROM students WHERE email=? AND password_hash=?",
      [email.trim(), pwHash]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const row = rows[0];
    return res.json({
      student_id: row.student_id,
      name: row.name,
      email: row.email,
      department: row.department,
      semester: row.semester,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── GOOGLE AUTH ──────────────────────────────────────────────────────────────
app.post("/api/auth/google", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "No token provided" });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: "66198409645-et081tedgqpqgpdorlicvauuhcf089o2.apps.googleusercontent.com",
    });
    const payload = ticket.getPayload();
    const email = payload.email.trim();
    const name = payload.name.trim();

    // Check if user exists
    let [rows] = await pool.execute(
      "SELECT student_id, name, email, department, semester FROM students WHERE email=?",
      [email]
    );

    let user;
    if (rows.length === 0) {
      // Create new user via Google Sign in
      const defaultPassword = hashPassword(crypto.randomBytes(16).toString('hex')); // Dummy password
      const [result] = await pool.execute(
        "INSERT INTO students (name, email, password_hash, department, semester) VALUES (?, ?, ?, ?, ?)",
        [name, email, defaultPassword, "N/A", 1]
      );
      user = {
        student_id: result.insertId,
        name,
        email,
        department: "N/A",
        semester: 1
      };
    } else {
      user = rows[0];
    }

    return res.json(user);
  } catch (e) {
    return res.status(500).json({ error: "Invalid Google token or database error" });
  }
});

// ── GET STUDENTS ─────────────────────────────────────────────────────────────
app.get("/students", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT student_id, name, email, teacher_email FROM students");
    return res.json(rows.map((r) => ({ id: r.student_id, name: r.name, email: r.email, teacher_email: r.teacher_email })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── REST OF AUTH / PROFILE ───────────────────────────────────────────────────
app.put("/students/:student_id", async (req, res) => {
  const { student_id } = req.params;
  const { name = "", email = "", department = "", semester = 1, teacher_email = null, password = "" } = req.body;

  try {
    // Check if new email is taken by someone else
    if (email) {
      const [existing] = await pool.execute("SELECT student_id FROM students WHERE email = ? AND student_id != ?", [email.trim(), student_id]);
      if (existing.length > 0) return res.status(409).json({ error: "Email already in use by another student" });
    }

    let q = "UPDATE students SET name=?, department=?, semester=?, teacher_email=?";
    let args = [name.trim(), department, semester, teacher_email];

    if (email) {
      q += ", email=?";
      args.push(email.trim());
    }

    if (password) {
      q += ", password_hash=?";
      args.push(hashPassword(password));
    }

    q += " WHERE student_id=?";
    args.push(student_id);

    await pool.execute(q, args);
    console.log(`✅ Student Profile Updated: ${name} (ID: ${student_id})`);
    return res.json({ message: "Profile updated" });
  } catch (e) {
    console.error("❌ Profile Update Error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── TEACHER AUTH API ─────────────────────────────────────────────────────────
app.post("/api/teacher/register", async (req, res) => {
  const { name = "", email = "", password = "" } = req.body;
  if (!name.trim() || !email.trim() || !password) return res.status(400).json({ error: "Missing fields" });

  const pwHash = hashPassword(password);
  try {
    const [result] = await pool.execute(
      "INSERT INTO teachers (name, email, password_hash) VALUES (?, ?, ?)",
      [name.trim(), email.trim(), pwHash]
    );
    return res.status(201).json({ teacher_id: result.insertId, name, email });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email already registered" });
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/teacher/login", async (req, res) => {
  const { email = "", password = "" } = req.body;
  const pwHash = hashPassword(password);
  try {
    const [rows] = await pool.execute("SELECT teacher_id, name, email, department FROM teachers WHERE email=? AND password_hash=?", [email.trim(), pwHash]);
    if (rows.length === 0) return res.status(401).json({ error: "Invalid email or password" });
    return res.json({ role: 'teacher', ...rows[0] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── TEACHER PROFILE API ──────────────────────────────────────────────────────
app.get("/api/teacher/profile/:teacher_id", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT teacher_id, name, email, department FROM teachers WHERE teacher_id=?", [req.params.teacher_id]);
    if (rows.length === 0) return res.status(404).json({ error: "Teacher not found" });
    return res.json(rows[0]);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.put("/api/teacher/profile/:teacher_id", async (req, res) => {
  const { teacher_id } = req.params;
  const { name, email, department, password } = req.body;
  try {
    // Check for email duplicates
    if (email) {
      const [existing] = await pool.execute("SELECT teacher_id FROM teachers WHERE email = ? AND teacher_id != ?", [email.trim(), teacher_id]);
      if (existing.length > 0) return res.status(409).json({ error: "Email already in use" });
    }

    let q = "UPDATE teachers SET name=?, department=?";
    let args = [name, department];

    if (email) {
      q += ", email=?";
      args.push(email.trim());
    }

    if (password) {
      q += ", password_hash=?";
      args.push(hashPassword(password));
    }

    q += " WHERE teacher_id=?";
    args.push(teacher_id);

    await pool.execute(q, args);
    console.log(`👨‍🏫 Teacher Profile Updated: ${name} (ID: ${teacher_id})`);
    return res.json({ message: "Teacher profile updated" });
  } catch (e) {
    console.error("❌ Teacher Update Error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/teacher/:email/students", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT student_id, name, email, department, semester FROM students WHERE teacher_email=?", [req.params.email]);
    return res.json(rows);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── EMAIL REPORT API WITH PDF ATTACHMENT ─────────────────────────────────────
app.post("/api/send-report", async (req, res) => {
  const {
    studentName,
    teacherEmail,
    stats,
    weakTopics,
    reportType = 'dashboard',
    quizTopic = '',
    quizScore = 0,
    quizTotal = 0,
    quizQuestions = []
  } = req.body;

  if (!teacherEmail) return res.status(400).json({ error: "No teacher email provided." });

  try {
    // 1. Generate PDF In-Memory
    const doc = new PDFDocument({ margin: 50 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    const pdfPromise = new Promise((resolve) => {
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
    });

    // Header logic
    const title = reportType === 'quiz' ? 'Quiz Performance Report' : 'Academic Progress Report';
    doc.fillColor('#1a1a2e').fontSize(24).text(title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).fillColor('#555').text(`Student: ${studentName}`, { align: 'left' });
    doc.text(`Date: ${new Date().toLocaleDateString()}`, { align: 'left' });
    if (reportType === 'quiz') doc.text(`Topic: ${quizTopic}`, { align: 'left' });
    doc.moveDown();
    doc.rect(50, doc.y, 500, 2).fill('#eeeeee');
    doc.moveDown();

    if (reportType === 'quiz') {
      // Quiz Specific Content
      doc.fillColor('#1a1a2e').fontSize(18).text(`Result: ${quizScore} / ${quizTotal} (${Math.round((quizScore / quizTotal) * 100)}%)`);
      doc.moveDown();

      doc.fontSize(14).text('Detailed Review:');
      doc.moveDown(0.5);

      quizQuestions.forEach((q, i) => {
        const isCorrect = q.selected === q.correct;
        doc.fontSize(11).fillColor('#333').text(`${i + 1}. ${q.question}`, { continued: false });
        doc.fontSize(10).fillColor(isCorrect ? '#2a9d8f' : '#e63946')
          .text(`   Your Answer: ${q.selectedText || 'N/A'} ${isCorrect ? '✓' : '✗'}`);
        if (!isCorrect) {
          doc.fillColor('#555').text(`   Correct Answer: ${q.correctText}`);
        }
        if (q.explanation) {
          doc.fontSize(9).fillColor('#777').text(`   Explanation: ${q.explanation}`);
        }
        doc.moveDown(0.5);
      });
    } else {
      // General Dashboard Content
      doc.fillColor('#1a1a2e').fontSize(18).text('Performance Snapshot');
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Overall Average: ${stats.overall_avg}%`);
      doc.text(`Strong Topics: ${stats.strong_count}`);
      doc.text(`Critical Areas: ${stats.critical_count}`);
      doc.moveDown();

      if (weakTopics && weakTopics.length > 0) {
        doc.fontSize(18).text('Priority Areas (Weak Topics)');
        doc.moveDown(0.5);
        weakTopics.forEach(t => {
          doc.fontSize(11).fillColor('#e63946').text(`• ${t.topic_name}: ${t.score_pct}%`);
        });
      }
    }

    doc.moveDown(2);
    doc.fontSize(10).fillColor('#777').text('Generated by Lumina AI Adaptive Learning System', { align: 'center' });
    doc.end();

    const pdfBuffer = await pdfPromise;

    // 2. Prepare & Send Email
    const subjectPrefix = reportType === 'quiz' ? `[QUIZ RESULT] ${quizTopic}` : '[PROGRESS REPORT]';
    const mailOptions = {
      from: '"Lumina AI Insights" <insights@lumina.ai>',
      to: teacherEmail,
      subject: `${subjectPrefix}: ${studentName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; color: #333;">
          <h1 style="color: #1a1a2e;">${reportType === 'quiz' ? 'Quiz Performance Summary' : 'Academic Progress Update'}</h1>
          <p>Hello,</p>
          <p>This is a report for <strong>${studentName}</strong> ${reportType === 'quiz' ? `who just completed a quiz on <strong>${quizTopic}</strong>.` : 'regarding their overall progress.'}</p>
          
          <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0;">Score: <strong style="font-size: 20px; color: #1a1a2e;">${reportType === 'quiz' ? `${quizScore}/${quizTotal}` : `${stats.overall_avg}%`}</strong></p>
          </div>
          
          <p>A detailed PDF containing the performance breakdown is attached to this email.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
          <p style="font-size: 12px; color: #999;">Sent automatically by the Lumina AI Intelligence System.</p>
        </div>
      `,
      attachments: [{
        filename: `${reportType}_Report_${studentName.replace(/\s+/g, '_')}.pdf`,
        content: pdfBuffer
      }]
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Quiz Report Email sent successfully!");
    return res.json({ message: "Email and PDF Sent!", url: nodemailer.getTestMessageUrl(info) });

  } catch (err) {
    console.error("❌ PDF/Email error:", err);
    return res.status(500).json({ error: "Failed to generate or send report: " + err.message });
  }
});

// ── GET PERFORMANCE (View) ───────────────────────────────────────────────────
app.get("/performance", async (req, res) => {
  // Pass optional student filter for teacher dashboard drilldown
  const { student_id } = req.query;
  try {
    let q = "SELECT * FROM student_performance_summary";
    let args = [];
    if (student_id) { q += " WHERE student_id=?"; args.push(student_id); }
    const [rows] = await pool.execute(q, args);
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── ADD SCORE ────────────────────────────────────────────────────────────────
app.post("/scores", async (req, res) => {
  const { student_id, topic_id, marks, max_marks, exam_date = null } = req.body;

  try {
    await pool.execute(
      "INSERT INTO scores (student_id, topic_id, marks_obtained, max_marks, exam_date) VALUES (?, ?, ?, ?, ?)",
      [student_id, topic_id, marks, max_marks, exam_date]
    );
    return res.json({ message: "Score added successfully" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── GET SUBJECTS ─────────────────────────────────────────────────────────────
app.get("/subjects", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT subject_id, name FROM subjects ORDER BY name");
    return res.json(rows.map((r) => ({ subject_id: r.subject_id, name: r.name })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── CREATE SUBJECT ───────────────────────────────────────────────────────────
app.post("/subjects", async (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "Subject name required" });
  }

  try {
    const [result] = await pool.execute("INSERT INTO subjects (name) VALUES (?)", [name]);
    return res.status(201).json({ subject_id: result.insertId, name });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── GET TOPICS for a subject ─────────────────────────────────────────────────
app.get("/topics", async (req, res) => {
  const { subject_id } = req.query;

  try {
    let rows;
    if (subject_id) {
      [rows] = await pool.execute(
        "SELECT topic_id, topic_name FROM topics WHERE subject_id=? ORDER BY topic_name",
        [subject_id]
      );
    } else {
      [rows] = await pool.execute("SELECT topic_id, topic_name FROM topics ORDER BY topic_name");
    }
    return res.json(rows.map((r) => ({ topic_id: r.topic_id, topic_name: r.topic_name })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── CREATE TOPIC ─────────────────────────────────────────────────────────────
app.post("/topics", async (req, res) => {
  const { subject_id } = req.body;
  const topicName = (req.body.topic_name || "").trim();

  if (!subject_id || !topicName) {
    return res.status(400).json({ error: "subject_id and topic_name required" });
  }

  try {
    const [result] = await pool.execute(
      "INSERT INTO topics (subject_id, topic_name) VALUES (?, ?)",
      [subject_id, topicName]
    );
    return res.status(201).json({ topic_id: result.insertId, topic_name: topicName });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── GET RECOMMENDATIONS ──────────────────────────────────────────────────────
app.get("/api/recommendations/:student_id", async (req, res) => {
  const { student_id } = req.params;

  try {
    // 1. First, ensure the study plan is generated/updated
    await pool.execute("CALL generate_study_roadmap(?)", [student_id]);

    // 2. Get weak topics from the study_plan table (status = 'pending')
    const [rows] = await pool.execute(
      `SELECT t.topic_name, sp.score_percentage 
       FROM study_plan sp 
       JOIN topics t ON sp.topic_id = t.topic_id 
       WHERE sp.student_id = ? AND sp.status = 'pending'
       ORDER BY sp.priority_score DESC LIMIT 3`,
      [student_id]
    );

    if (rows.length === 0) {
      return res.json({
        status: "success",
        advice: "You're doing great! No critical weak areas found. Keep up the good work."
      });
    }

    // Use the specialized AI Study Advice function from aiService.js
    const advice = await getAIStudyAdvice(rows);

    return res.json({
      status: "success",
      topics: rows,
      advice: advice || "Your AI Advisor is currently busy. Focus on reviewing your weak topics!"
    });
  } catch (e) {
    return res.status(500).json({ status: "error", message: e.message });
  }
});

// ── GENERATE QUIZ ────────────────────────────────────────────────────────────
app.post("/api/generate-quiz", async (req, res) => {
  const { topic = "", files = [], count = 5 } = req.body;

  let sourceText = topic;

  try {
    // Extract text from uploaded PDFs if any
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mimeType === "application/pdf" && file.data) {
          const buffer = Buffer.from(file.data, "base64");
          let pdfData;
          try {
            // Robust detection of pdf-parse function
            const parser = (typeof pdf === 'function') ? pdf : (pdf && typeof pdf.default === 'function' ? pdf.default : null);
            if (!parser) throw new Error("PDF parser function not found");

            pdfData = await parser(buffer);
            const extractedText = pdfData.text || "";
            console.log(`📄 PDF Extracted (${file.name || "Unknown"}): ${extractedText.length} characters`);
            sourceText += `\n\n--- Content from ${file.name || "PDF"} ---\n${extractedText}`;
          } catch (pdfErr) {
            console.error("PDF Parse error:", pdfErr);
            sourceText += `\n\n[Error parsing PDF: ${file.name}]`;
          }
        }
      }
    }

    if (!sourceText.trim()) {
      return res.status(400).json({ error: "Topic or PDF content required" });
    }

    // Always use Groq (via generateQuizFromText) for quizzes
    const quiz = await generateQuizFromText(sourceText, count);

    if (quiz) {
      return res.json({ status: "success", quiz });
    } else {
      return res.status(500).json({ error: "Failed to generate quiz from Groq" });
    }
  } catch (e) {
    console.error(`Quiz Route Error: ${e.message}`);
    return res.status(500).json({ error: "Internal server error during quiz generation" });
  }
});

// ── GENERATE FLASHCARDS ──────────────────────────────────────────────────────
app.post("/api/generate-flashcards", async (req, res) => {
  const { topic } = req.body;

  if (!topic) {
    return res.status(400).json({ error: "Topic name required" });
  }

  const flashcards = await generateFlashcards(topic);

  if (flashcards) {
    return res.json({ status: "success", flashcards });
  } else {
    return res.status(500).json({ error: "Failed to generate flashcards" });
  }
});

// ── AI CHAT ──────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [], files = [], systemInstruction = null } = req.body;

  let sourceText = message;
  let imageFiles = [];

  try {
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mimeType === "application/pdf" && file.data) {
          const buffer = Buffer.from(file.data, "base64");
          try {
            // Robust detection of pdf-parse function
            const parser = (typeof pdf === 'function') ? pdf : (pdf && typeof pdf.default === 'function' ? pdf.default : null);
            if (!parser) throw new Error("PDF parser function not found");

            const pdfData = await parser(buffer);
            const extractedText = pdfData.text || "";
            console.log(`📄 Chat PDF Extracted: ${extractedText.length} characters`);
            sourceText += `\n\n--- Content from PDF ---\n${extractedText}`;
          } catch (pdfErr) {
            console.error("PDF Parse error in chat:", pdfErr);
          }
        } else if (file.mimeType && file.mimeType.startsWith("image/")) {
          imageFiles.push(file);
        }
      }
    }

    // Completely bypass Gemini and use Groq for both Text/PDF parsing and Image Vision Tasks
    const replyText = await getTutorResponse(sourceText, history, imageFiles, systemInstruction);

    if (replyText) {
      return res.json({ status: "success", reply: replyText });
    } else {
      return res.status(500).json({
        status: "error",
        message: "The AI encountered an error processing this request.",
      });
    }
  } catch (e) {
    console.error("Chat Error:", e);
    return res.status(500).json({ status: "error", message: e.message });
  }
});

// ── RUN ──────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
