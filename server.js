import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: true }));
app.use(express.json());

// MySQL-Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: "utf8mb4"
});

// OpenAI-Client (optional; /generate nur aktiv, wenn Key vorhanden)
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Healthcheck
app.get("/health", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GPT: Tasks generieren
app.post("/generate", async (req, res) => {
  if (!openai) return res.status(400).json({ error: "OPENAI_API_KEY fehlt im Backend (.env)" });
  try {
    const { projectDescription } = req.body;
    const prompt = `
Du bist ein Projektplanungsassistent. Erzeuge aus dieser Beschreibung eine Liste von Tasks mit Start- und Enddatum (ISO), frei wählbaren Kategorien und Verantwortlichen.
Gib *nur* JSON im Format zurück:
{
  "tasks": [
    {
      "name": "Taskname",
      "category": "Kategorie",
      "start": "YYYY-MM-DD",
      "end": "YYYY-MM-DD",
      "responsible": "Name"
    }
  ],
  "categories": ["Kategorie1", "Kategorie2"]
}
Beschreibung: """${projectDescription ?? ""}"""
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });

    const content = completion.choices?.[0]?.message?.content ?? "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }
    res.json(parsed);
  } catch (err) {
    console.error("Generate error:", err);
    res.status(500).json({ error: "Fehler bei der Task-Generierung" });
  }
});

// Projekt speichern
app.post("/save", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { project, tasks } = req.body;
    await conn.beginTransaction();

    const [projResult] = await conn.query(
      `INSERT INTO projects (kunde, titel, datum, off_office, notizen) VALUES (?, ?, ?, ?, ?)`,
      [project.kunde, project.titel, project.datum, project.off_office ?? "Off Office", project.notizen ?? ""]
    );
    const projectId = projResult.insertId;

    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        await conn.query(
          `INSERT INTO tasks (project_id, name, category, start, end_date, responsible, dependencies)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [projectId, t.name, t.category, t.start, t.end, t.responsible, t.dependencies ?? ""]
        );
      }
    }

    await conn.commit();
    res.json({ success: true, projectId });
  } catch (err) {
    await conn.rollback();
    console.error("Save error:", err);
    res.status(500).json({ error: "Fehler beim Speichern" });
  } finally {
    conn.release();
  }
});

// Projekt laden
app.get("/load/:id", async (req, res) => {
  try {
    const [projects] = await pool.query(`SELECT * FROM projects WHERE id = ?`, [req.params.id]);
    if (projects.length === 0) return res.status(404).json({ error: "Projekt nicht gefunden" });

    const [tasks] = await pool.query(
      `SELECT * FROM tasks WHERE project_id = ? ORDER BY start, id`,
      [req.params.id]
    );

    res.json({ project: projects[0], tasks });
  } catch (err) {
    console.error("Load error:", err);
    res.status(500).json({ error: "Fehler beim Laden" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend läuft auf Port ${PORT}`);
});