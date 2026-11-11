// Checks the Draggable_ListView page (/p/draggable-list-view) of a running app:
// List View -> Data View -> MxTechies Draggable, every note keeps its own position.
// usage: MX_USER=MxAdmin MX_PASS=1 CHROME_PATH=... node test/test-list-view.mjs
import puppeteer from "puppeteer-core";

const BASE = process.env.MX_URL || "http://localhost:8080";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (n, ok, info = "") => {
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"} ${n}${!ok && info ? " - " + info : ""}`);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const p = await browser.newPage();
const errors = [];
p.on("pageerror", e => errors.push(String(e)));
await p.setViewport({ width: 1440, height: 1000 });
await p.goto(BASE + "/login.html", { waitUntil: "networkidle2" });
await p.type("#usernameInput", process.env.MX_USER || "MxAdmin");
await p.type("#passwordInput", process.env.MX_PASS || "1");
await p.keyboard.press("Enter");
await p.waitForFunction(() => !location.pathname.includes("login"), { timeout: 60000 });
const open = async () => {
    await p.goto(BASE + "/p/draggable-list-view", { waitUntil: "domcontentloaded" });
    await p.waitForSelector(".dld-note", { timeout: 120000 });
    await sleep(2500);
};
await open();
await p.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Reset positions")?.click());
await sleep(3000);
await open();
const rect = t =>
    p.evaluate(t => {
        const n = [...document.querySelectorAll(".dld-note")].find(x => x.querySelector(".dld-note-title").textContent.trim() === t);
        const b = n.getBoundingClientRect();
        return { x: b.x, y: b.y, h: b.height };
    }, t);
const topTitle = (x, y) =>
    p.evaluate((x, y) => document.elementFromPoint(x, y)?.closest(".dld-note")?.querySelector(".dld-note-title")?.textContent.trim() ?? null, x, y);
const drag = async (r, dx, dy) => {
    await p.mouse.move(r.x + 40, r.y + r.h / 2);
    await p.mouse.down();
    await p.mouse.move(r.x + 40 + dx, r.y + r.h / 2 + dy, { steps: 18 });
};
check("five notes listed", (await p.$$(".dld-note")).length === 5);
const a = await rect("Plan the sprint");
const c = await rect("Release notes");
const dx = 260;
const dy = Math.round(c.y - a.y);
await drag(a, dx, dy);
await sleep(300);
check("while dragging, the note is drawn above the rows below", (await topTitle(a.x + 40 + dx, a.y + a.h / 2 + dy)) === "Plan the sprint");
await p.mouse.up();
await sleep(2500);
check("after the drop it stays on top", (await topTitle(a.x + 40 + dx, a.y + a.h / 2 + dy)) === "Plan the sprint");
const b = await rect("Customer call");
await drag(b, 480, 40);
await p.mouse.up();
await sleep(2500);
const bDrop = await rect("Customer call");
await open();
const a2 = await rect("Plan the sprint");
const b2 = await rect("Customer call");
const c2 = await rect("Release notes");
check("after a reload the first note is still moved", Math.abs(a2.x - (a.x + dx)) < 3 && Math.abs(a2.y - (a.y + dy)) < 3);
check("after a reload the second note kept its own position", Math.abs(b2.x - bDrop.x) < 3 && Math.abs(b2.y - bDrop.y) < 3);
check("untouched notes stay in place", Math.abs(c2.x - c.x) < 2 && Math.abs(c2.y - c.y) < 2);
check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
