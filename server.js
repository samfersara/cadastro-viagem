const express = require("express")
const multer = require("multer")
const nodemailer = require("nodemailer")
const PDFDocument = require("pdfkit")
const Excel = require("exceljs")
const session = require("express-session")
const fs = require("fs")
const path = require("path")
require("dotenv").config()

const app = express()

app.use(express.static("public"))
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const upload = multer({ storage: multer.memoryStorage() })

const ADMIN_USER = process.env.ADMIN_USER || "admin"
const ADMIN_PASS = process.env.ADMIN_PASS || "admin"
const SESSION_SECRET = process.env.SESSION_SECRET || "viagem-secret"
const TOTAL_PASSAGEIROS = Number(process.env.TOTAL_PASSAGEIROS || 45)
const DB = process.env.DB_PATH || "passageiros.json"

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" }
  })
)

if (!fs.existsSync(DB)) fs.writeFileSync(DB, "[]")

function loadDB() {
  return JSON.parse(fs.readFileSync(DB, "utf8"))
}

function saveDB(data) {
  fs.writeFileSync(DB, JSON.stringify(data, null, 2))
}

function requireAdmin(req, res, next) {
  if (req.session?.admin) return next()
  return res.redirect("/admin/login")
}

function safeFileName(v) {
  return String(v || "")
    .replace(/[\/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .trim()
}

function safeText(v) {
  return String(v || "").trim()
}

function extrairFilhos(d) {
  const filhos = []

  Object.keys(d).forEach((k) => {
    if (/^filho\d+_nome$/.test(k) && d[k]) {
      filhos.push(d[k])
    }
  })

  return filhos
}

function contarPassageirosRegistro(d) {
  let total = 1
  if (d.conjuge_nome && String(d.conjuge_nome).trim()) total += 1
  total += Number(d.qtdFilhos || 0)
  return total
}

function contarPassageirosTotais(lista) {
  return lista.reduce((acc, item) => acc + contarPassageirosRegistro(item), 0)
}

function resumoTexto(body) {
  const linhas = []

  linhas.push(`Viajante: ${body.viajante_nome || "-"}`)
  linhas.push(`Cônjuge: ${body.conjuge_nome || "Não possui"}`)
  linhas.push(`Quantidade de filhos: ${body.qtdFilhos || 0}`)

  const filhos = extrairFilhos(body)
  if (filhos.length) {
    linhas.push(`Filhos: ${filhos.join(", ")}`)
  }

  return linhas.join("\n")
}

function extensaoDoArquivo(filename, mimetype) {
  const extOriginal = path.extname(filename || "").trim()
  if (extOriginal) return extOriginal

  const mapa = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "application/pdf": ".pdf",
    "image/webp": ".webp"
  }

  return mapa[mimetype] || ""
}

function nomeArquivoAmigavel(file) {
  let nome = file.fieldname

  nome = nome.replace("rgCpfFile", "Documento_RG_CPF")
  nome = nome.replace("vacina", "Carteira_Vacinacao")
  nome = nome.replace("termoAutorizacao", "Termo_Autorizacao")

  return safeFileName(nome) + extensaoDoArquivo(file.originalname, file.mimetype)
}

function gerarPdfBuffer(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: "A4" })
    const chunks = []

    doc.on("data", (chunk) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text("FICHA DE VIAGEM", { align: "center" })
    doc.moveDown(0.2)
    doc.font("Helvetica").fontSize(10).fillColor("#475569").text(`Gerada em: ${new Date().toLocaleString("pt-BR")}`, { align: "center" })
    doc.moveDown(1.2)

    doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text("Viajante")
    doc.moveDown(0.4)
    doc.font("Helvetica").fontSize(11).fillColor("#111827").text(`Nome: ${d.viajante_nome || "-"}`)
    doc.moveDown(1)

    if (d.conjuge_nome) {
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text("Cônjuge")
      doc.moveDown(0.4)
      doc.font("Helvetica").fontSize(11).fillColor("#111827").text(`Nome: ${d.conjuge_nome}`)
      doc.moveDown(1)
    }

    const filhos = extrairFilhos(d)
    if (filhos.length) {
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text("Filhos")
      doc.moveDown(0.4)

      filhos.forEach((f, i) => {
        doc.font("Helvetica").fontSize(11).fillColor("#111827").text(`Filho ${i + 1}: ${f}`)
      })

      doc.moveDown(1)
    }

    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text("Documentação")
    doc.moveDown(0.4)
    doc.font("Helvetica").fontSize(10).fillColor("#334155").text("Os documentos enviados seguem em anexo no e-mail, incluindo o termo de autorização.")
    doc.moveDown(1.2)

    doc.font("Helvetica").fontSize(9).fillColor("#64748b")
      .text("Documento gerado automaticamente pelo sistema de cadastro da viagem.", { align: "center" })

    doc.end()
  })
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
})

app.post("/enviar", upload.any(), async (req, res) => {
  try {
    const dados = loadDB()

    const pdfBuffer = await gerarPdfBuffer(req.body)

    const anexos = [
      {
        filename: "FICHA.pdf",
        content: pdfBuffer,
        contentType: "application/pdf"
      },
      ...req.files.map((f) => ({
        filename: nomeArquivoAmigavel(f),
        content: f.buffer,
        contentType: f.mimetype
      }))
    ]

    await transporter.sendMail({
      from: `"Cadastro Viagem" <${process.env.SMTP_USER}>`,
      to: process.env.MAIL_TO,
      subject: `Novo cadastro de viagem - ${safeText(req.body.viajante_nome)}`,
      text: resumoTexto(req.body),
      attachments: anexos
    })

    dados.push(req.body)
    saveDB(dados)

    return res.json({ ok: true, message: "Cadastro feito com sucesso!" })
  } catch (e) {
    console.error("ERRO /enviar:", e)
    return res.status(500).json({ ok: false, message: "Erro ao enviar cadastro." })
  }
})

function adminShell({ title, body, extraHead = "" }) {
  return `
<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>

<style>
:root{
  --bg:#0b1220;
  --card:#0f172a;
  --muted:#94a3b8;
  --text:#e2e8f0;
  --line:rgba(148,163,184,.18);
  --brand:#2563eb;
  --brand2:#22c55e;
  --danger:#ef4444;
}

*{box-sizing:border-box}

body{
  margin:0;
  font-family:Segoe UI, Arial, sans-serif;
  background: radial-gradient(900px 600px at 20% 10%, rgba(37,99,235,.25), transparent 60%),
              radial-gradient(800px 500px at 90% 30%, rgba(34,197,94,.18), transparent 55%),
              linear-gradient(180deg, #0b1220, #070b14);
  color:var(--text);
  min-height:100vh;
}

.wrap{
  max-width:1100px;
  margin:auto;
  padding:30px;
}

.top{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:14px;
  margin-bottom:20px;
  flex-wrap:wrap;
}

.brand{
  display:flex;
  gap:12px;
  align-items:center;
}

.logo{
  width:40px;
  height:40px;
  border-radius:10px;
  background:linear-gradient(135deg,#2563eb,#22c55e);
  box-shadow: 0 10px 30px rgba(37,99,235,.25);
}

h1{
  margin:0;
  font-size:22px;
}

.sub{
  color:var(--muted);
  font-size:13px;
}

.card{
  background:rgba(255,255,255,.04);
  border:1px solid var(--line);
  border-radius:16px;
  padding:18px;
  margin-bottom:20px;
  box-shadow:0 18px 45px rgba(0,0,0,.25);
}

.grid{
  display:grid;
  grid-template-columns:1.1fr .9fr;
  gap:14px;
  margin-bottom:14px;
}

@media(max-width:900px){
  .grid{grid-template-columns:1fr;}
}

.stat{
  font-size:30px;
  font-weight:bold;
}

.statLbl{
  color:var(--muted);
  font-size:12px;
  margin-top:6px;
}

.bar{
  height:10px;
  background:#1e293b;
  border-radius:6px;
  overflow:hidden;
  margin-top:10px;
  border:1px solid var(--line);
}

.fill{
  height:100%;
  background:linear-gradient(90deg,#2563eb,#22c55e);
  width:0%;
  transition:width .4s ease;
}

table{
  width:100%;
  border-collapse:collapse;
  background:rgba(255,255,255,.03);
  border-radius:12px;
  overflow:hidden;
  border:1px solid var(--line);
}

th,td{
  padding:12px;
  border-bottom:1px solid rgba(148,163,184,.12);
  text-align:left;
  vertical-align:top;
}

th{
  color:var(--muted);
  font-size:12px;
  font-weight:700;
}

tbody tr:hover{
  background:rgba(255,255,255,.04);
}

.name{
  font-weight:bold;
  font-size:15px;
}

.muted{
  color:var(--muted);
  font-size:12px;
  margin-top:4px;
}

.btn{
  padding:8px 12px;
  border-radius:8px;
  border:none;
  cursor:pointer;
  font-weight:bold;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  gap:8px;
}

.btn-danger{
  background:#ef4444;
  color:white;
}

.btn-primary{
  background:#2563eb;
  color:white;
}

.btn-dark{
  background:rgba(255,255,255,.05);
  color:white;
  border:1px solid var(--line);
}

.search{
  width:100%;
  padding:10px;
  border-radius:10px;
  border:1px solid var(--line);
  background:rgba(255,255,255,.05);
  color:white;
  outline:none;
}

.search::placeholder{
  color:#94a3b8;
}

.loginWrap{
  max-width:440px;
  margin:70px auto;
}

.field{
  margin-top:10px;
}

.field label{
  display:block;
  color:var(--muted);
  font-size:12px;
  font-weight:700;
  margin-bottom:6px;
}

.input{
  width:100%;
  padding:12px;
  border-radius:12px;
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--text);
  outline:none;
}

.error{
  margin-top:10px;
  color:#fecaca;
  background:rgba(239,68,68,.12);
  border:1px solid rgba(239,68,68,.35);
  padding:10px 12px;
  border-radius:12px;
  font-weight:700;
  font-size:12px;
}
</style>

${extraHead}
</head>
<body>
${body}
</body>
</html>
`
}

app.get("/admin/login", (req, res) => {
  res.send(
    adminShell({
      title: "Login - Admin",
      body: `
      <div class="wrap loginWrap">
        <div class="card">
          <div class="brand" style="margin-bottom:12px">
            <div class="logo"></div>
            <div>
              <h1>Admin da Viagem</h1>
              <div class="sub">Acesso restrito</div>
            </div>
          </div>

          <form method="POST" action="/admin/login">
            <div class="field">
              <label>Usuário</label>
              <input class="input" name="user" required />
            </div>

            <div class="field">
              <label>Senha</label>
              <input class="input" name="pass" type="password" required />
            </div>

            <div style="margin-top:14px">
              <button class="btn btn-primary" style="width:100%;justify-content:center">Entrar</button>
            </div>
          </form>
        </div>
      </div>`
    })
  )
})

app.post("/admin/login", (req, res) => {
  if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
    req.session.admin = true
    return res.redirect("/admin")
  }

  res.send(
    adminShell({
      title: "Login - Admin",
      body: `
      <div class="wrap loginWrap">
        <div class="card">
          <div class="brand" style="margin-bottom:12px">
            <div class="logo"></div>
            <div>
              <h1>Admin da Viagem</h1>
              <div class="sub">Acesso restrito</div>
            </div>
          </div>

          <form method="POST" action="/admin/login">
            <div class="field">
              <label>Usuário</label>
              <input class="input" name="user" required />
            </div>

            <div class="field">
              <label>Senha</label>
              <input class="input" name="pass" type="password" required />
            </div>

            <div style="margin-top:14px">
              <button class="btn btn-primary" style="width:100%;justify-content:center">Entrar</button>
            </div>
          </form>

          <div class="error">Usuário ou senha inválidos.</div>
        </div>
      </div>`
    })
  )
})

app.post("/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"))
})

app.get("/admin", requireAdmin, (req, res) => {
  const dados = loadDB()

  const totalCadastros = dados.length
  const totalPassageiros = contarPassageirosTotais(dados)
  const pct = Math.min(100, Math.round((totalPassageiros / TOTAL_PASSAGEIROS) * 100))

  const rows = dados
    .slice()
    .reverse()
    .map((d) => {
      const nome = d.viajante_nome || "-"
      const nomeConjuge = d.conjuge_nome || ""
      const filhos = extrairFilhos(d)
      const qtdFilhos = filhos.length

      const conjugeHtml = nomeConjuge
        ? `<div class="muted"><strong>Cônjuge:</strong> ${nomeConjuge}</div>`
        : `<div class="muted"><strong>Cônjuge:</strong> Não</div>`

      const filhosHtml = filhos.length
        ? `<div class="muted"><strong>Filhos (${qtdFilhos}):</strong> ${filhos.join(", ")}</div>`
        : `<div class="muted"><strong>Filhos:</strong> 0</div>`

      return `
        <tr data-nome="${String(nome).toLowerCase()}">
          <td>
            <div class="name">${nome}</div>
            ${conjugeHtml}
            ${filhosHtml}
          </td>
          <td>${contarPassageirosRegistro(d)}</td>
          <td>
            <form method="POST" action="/admin/delete" onsubmit="return confirm('Excluir cadastro de ${safeFileName(nome)}?')">
              <input type="hidden" name="viajante_nome" value="${nome}">
              <button class="btn btn-danger">Excluir</button>
            </form>
          </td>
        </tr>
      `
    })
    .join("")

  res.send(
    adminShell({
      title: "Admin",
      extraHead: `
      <script>
        function filtrar(){
          const q = document.getElementById("q").value.toLowerCase().trim()

          document.querySelectorAll("tbody tr").forEach(tr=>{
            const nome = tr.dataset.nome || ""
            tr.style.display = nome.includes(q) ? "" : "none"
          })
        }

        window.addEventListener("DOMContentLoaded", ()=>{
          const fill = document.getElementById("fill")
          const pct = Number(fill.getAttribute("data-pct") || 0)
          requestAnimationFrame(()=>{ fill.style.width = pct + "%" })
        })
      </script>
      `,
      body: `
      <div class="wrap">

        <div class="top">
          <div class="brand">
            <div class="logo"></div>
            <div>
              <h1>Painel da Viagem</h1>
              <div class="sub">Controle de passageiros</div>
            </div>
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <a href="/excel" class="btn btn-primary">Baixar Excel</a>
            <form method="POST" action="/admin/logout" style="margin:0">
              <button class="btn btn-dark" type="submit">Sair</button>
            </form>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <div class="stat">${totalPassageiros} / ${TOTAL_PASSAGEIROS}</div>
            <div class="statLbl">Passageiros contabilizados</div>
            <div class="bar">
              <div class="fill" id="fill" data-pct="${pct}"></div>
            </div>
            <div class="muted" style="margin-top:10px;">${pct}% da meta total</div>
          </div>

          <div class="card">
            <div class="stat">${totalCadastros}</div>
            <div class="statLbl">Fichas enviadas</div>
            <div class="muted" style="margin-top:10px;">Cada ficha pode incluir viajante, cônjuge e filhos.</div>
          </div>
        </div>

        <div class="card">
          <input id="q" class="search" placeholder="Buscar por nome do viajante" oninput="filtrar()">
        </div>

        <table>
          <thead>
            <tr>
              <th>Ficha</th>
              <th>Total de passageiros</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="3">Nenhum cadastro</td></tr>`}
          </tbody>
        </table>

      </div>
      `
    })
  )
})

app.post("/admin/delete", requireAdmin, (req, res) => {
  let dados = loadDB()
  dados = dados.filter((d) => d.viajante_nome !== req.body.viajante_nome)
  saveDB(dados)
  res.redirect("/admin")
})

app.get("/excel", requireAdmin, async (req, res) => {
  const dados = loadDB()

  const wb = new Excel.Workbook()
  const ws = wb.addWorksheet("Passageiros")

  ws.columns = [
    { header: "Viajante", key: "v", width: 30 },
    { header: "Cônjuge", key: "c", width: 30 },
    { header: "Qtd. Filhos", key: "qf", width: 12 },
    { header: "Filhos", key: "f", width: 40 },
    { header: "Total de Passageiros", key: "tp", width: 18 }
  ]

  dados.forEach((d) => {
    const filhos = extrairFilhos(d)

    ws.addRow({
      v: d.viajante_nome || "",
      c: d.conjuge_nome || "",
      qf: filhos.length,
      f: filhos.join(", "),
      tp: contarPassageirosRegistro(d)
    })
  })

  const file = path.join(__dirname, "lista.xlsx")
  await wb.xlsx.writeFile(file)
  res.download(file)
})

const PORT = process.env.PORT || 3000

app.listen(PORT, "0.0.0.0", () => {
  console.log("🚍 SISTEMA VIAGEM ONLINE rodando na porta", PORT)
})