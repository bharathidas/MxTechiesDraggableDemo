import puppeteer from "puppeteer-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:8080/";
const results = [];
const consoleErrors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function record(name, pass, detail) {
    results.push({ name, pass, detail });
}

async function rect(handle) {
    return handle.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, transform: el.style.transform };
    });
}

/** Press on `from`, move by (dx, dy) in steps, release. Returns nothing; measure the box yourself. */
async function dragFrom(page, from, dx, dy, steps = 12, holdBeforeUp) {
    const box = await from.boundingBox();
    const sx = box.x + Math.min(box.width / 2, 40);
    const sy = box.y + Math.min(box.height / 2, 14);
    await page.mouse.move(sx, sy);
    await sleep(40);
    await page.mouse.down();
    await sleep(40);
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(sx + (dx * i) / steps, sy + (dy * i) / steps);
        await sleep(8);
    }
    if (holdBeforeUp) await holdBeforeUp();
    await page.mouse.up();
    await sleep(200);
}

async function moved(page, name, dx, dy, from) {
    const box = await page.$(`.mx-name-${name}`);
    const before = await rect(box);
    await dragFrom(page, from ?? box, dx, dy);
    const after = await rect(box);
    return { dx: after.x - before.x, dy: after.y - before.y, before, after, box };
}

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    defaultViewport: { width: 1400, height: 1000 }
});
try {
    const page = await browser.newPage();
    page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", err => consoleErrors.push(String(err)));

    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
    if (page.url().includes("login")) {
        const user = process.env.MX_USER || "MxAdmin";
        const pass = process.env.MX_PASS || "1";
        await page.waitForSelector("#usernameInput, input[name='username'], input[type='text']", { timeout: 15000 });
        await page.type("#usernameInput, input[name='username'], input[type='text']", user);
        await page.type("#passwordInput, input[name='password'], input[type='password']", pass);
        await page.keyboard.press("Enter");
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        await sleep(1500);
        if (page.url().includes("login")) {
            throw new Error(`Login failed for ${user}: still on ${page.url()}`);
        }
        console.log(`logged in as ${user}`);
        // The anonymous session probe before sign-in logs an expected 401; only count errors after login.
        consoleErrors.length = 0;
    }
    await page.waitForFunction(
        () => [...document.querySelectorAll("a, button")].some(el => (el.textContent || "").includes("Draggable test")),
        { timeout: 30000 }
    );
    await page.evaluate(() => {
        [...document.querySelectorAll("a, button")].find(e => (e.textContent || "").includes("Draggable test")).click();
    });
    await page.waitForSelector(".mx-name-boxAbsolute", { timeout: 30000 });
    await page.waitForFunction(() => /Active drag handlers: \d/.test(document.body.innerText), { timeout: 30000 });
    await sleep(500);
    await page.screenshot({ path: path.join(here, "ex-01-initial.png"), fullPage: true });

    const count = await page.$$eval(".mxt-draggable", els => els.length);
    record("17 draggable widgets rendered", count === 17, `found ${count}`);

    const counterText = async () => page.$eval(".mx-name-activeDragsText", el => el.textContent.trim());

    // 1. Anywhere + drag counter via On drag start / On drag stop microflows.
    let duringDrag = "";
    const anyBox = await page.$(".mx-name-boxAnywhere");
    const any0 = await rect(anyBox);
    await dragFrom(page, anyBox, 60, 40, 12, async () => {
        await sleep(900);
        duringDrag = await counterText();
    });
    await sleep(900);
    const any1 = await rect(anyBox);
    record("anywhere: moves freely", near(any1.x - any0.x, 60) && near(any1.y - any0.y, 40), `d=(${(any1.x - any0.x).toFixed(0)}, ${(any1.y - any0.y).toFixed(0)})`);
    record("anywhere: On drag start microflow raised the counter to 1", /:\s*1$/.test(duringDrag), duringDrag);
    const afterDrag = await counterText();
    record("anywhere: On drag stop microflow lowered the counter to 0", /:\s*0$/.test(afterDrag), afterDrag);

    // Interactive UI: position badge and active class appear only while dragging.
    let badgeText = "";
    let activeDuring = false;
    const anyBox2 = await page.$(".mx-name-boxAxisX");
    const axBefore = await rect(anyBox2);
    await dragFrom(page, anyBox2, 30, 0, 6, async () => {
        badgeText = await page.$eval(".mx-name-boxAxisX .mxt-draggable__badge", el => el.textContent.trim()).catch(() => "");
        activeDuring = await page.$eval(".mx-name-boxAxisX", el => el.classList.contains("mxt-draggable--active"));
        await page.screenshot({ path: path.join(here, "ex-03-dragging.png"), clip: { x: 0, y: 0, width: 1400, height: 520 } });
    });
    const badgeAfter = await page.$(".mx-name-boxAxisX .mxt-draggable__badge");
    record("badge: shows live x, y while dragging", /^\d+, \d+$/.test(badgeText) && badgeText.startsWith("30"), badgeText || "(none)");
    record("badge: hidden again after drop; active class toggles", badgeAfter === null && activeDuring, `after=${badgeAfter === null ? "hidden" : "visible"} activeDuring=${activeDuring}`);
    // put the box back so the later axis check starts from a known place
    await dragFrom(page, anyBox2, -30, 0, 6);
    const axReset = await rect(anyBox2);
    if (!near(axReset.x, axBefore.x)) console.log("note: boxAxisX reset drift", axReset.x - axBefore.x);

    // 2 + 3. Axis locks.
    const ax = await moved(page, "boxAxisX", 60, 40);
    record("x axis only: moves horizontally, not vertically", near(ax.dx, 60) && near(ax.dy, 0), `d=(${ax.dx.toFixed(0)}, ${ax.dy.toFixed(0)})`);
    const ay = await moved(page, "boxAxisY", 60, 40);
    record("y axis only: moves vertically, not horizontally", near(ay.dx, 0) && near(ay.dy, 40), `d=(${ay.dx.toFixed(0)}, ${ay.dy.toFixed(0)})`);

    // 4. Disabled.
    const dis = await moved(page, "boxDisabled", 60, 40);
    record("disabled: does not move", near(dis.dx, 0) && near(dis.dy, 0), `d=(${dis.dx.toFixed(0)}, ${dis.dy.toFixed(0)})`);

    // 5. Track position through attributes.
    const tr = await moved(page, "boxTrack", 70, 30);
    await sleep(400);
    const trackText = await page.$eval(".mx-name-boxTrackValues", el => el.textContent.trim());
    record("track: X/Y attributes updated on drop", trackText === "x: 70, y: 30", trackText);

    // 6. Handle.
    const hBody = await page.$(".mx-name-boxHandleText");
    const h1 = await moved(page, "boxHandle", 50, 30, hBody);
    record("handle: dragging the body does nothing", near(h1.dx, 0) && near(h1.dy, 0), `d=(${h1.dx.toFixed(0)}, ${h1.dy.toFixed(0)})`);
    const hGrip = await page.$(".mx-name-boxHandleGrip");
    const h2 = await moved(page, "boxHandle", 50, 30, hGrip);
    record("handle: dragging the handle moves the box", near(h2.dx, 50) && near(h2.dy, 30), `d=(${h2.dx.toFixed(0)}, ${h2.dy.toFixed(0)})`);

    // 7. Scrollable content with handle.
    const sGrip = await page.$(".mx-name-boxScrollGrip");
    const s1 = await moved(page, "boxScroll", 40, 20, sGrip);
    record("scroll box: handle drags it", near(s1.dx, 40) && near(s1.dy, 20), `d=(${s1.dx.toFixed(0)}, ${s1.dy.toFixed(0)})`);
    const scrollable = await page.$eval(".mx-name-boxScrollArea", el => el.scrollHeight > el.clientHeight);
    record("scroll box: inner content scrolls", scrollable, `scrollHeight > clientHeight = ${scrollable}`);

    // 8. Cancel.
    const cZone = await page.$(".mx-name-boxCancelZone");
    const c1 = await moved(page, "boxCancel", 50, 30, cZone);
    record("cancel: dragging the cancel zone does nothing", near(c1.dx, 0) && near(c1.dy, 0), `d=(${c1.dx.toFixed(0)}, ${c1.dy.toFixed(0)})`);
    const cText = await page.$(".mx-name-boxCancelText");
    const c2 = await moved(page, "boxCancel", 50, 30, cText);
    record("cancel: dragging elsewhere works", near(c2.dx, 50) && near(c2.dy, 30), `d=(${c2.dx.toFixed(0)}, ${c2.dy.toFixed(0)})`);

    // 9 + 10. Grids.
    const g25 = await moved(page, "boxGrid25", 60, 60);
    record("grid 25: snaps to 25px steps", g25.dx % 25 === 0 && g25.dy % 25 === 0 && g25.dx > 0, `d=(${g25.dx.toFixed(0)}, ${g25.dy.toFixed(0)})`);
    const g50 = await moved(page, "boxGrid50", 60, 60);
    record("grid 50: snaps to 50px steps", near(g50.dx, 50) && near(g50.dy, 50), `d=(${g50.dx.toFixed(0)}, ${g50.dy.toFixed(0)})`);

    // 11. Offset bounds: at most 100px from start.
    const off = await moved(page, "boxOffset", 300, 300, undefined);
    record("offset bounds: limited to 100px", near(off.dx, 100) && near(off.dy, 100), `d=(${off.dx.toFixed(0)}, ${off.dy.toFixed(0)})`);

    // 12. Body bounds: cannot leave the document.
    const body = await moved(page, "boxBody", -2000, -2000, undefined);
    record("body bounds: stays inside the body", body.after.x >= -1 && body.after.y >= -1, `pos=(${body.after.x.toFixed(0)}, ${body.after.y.toFixed(0)})`);

    // 13. Default position.
    const def = await page.$eval(".mx-name-boxDefaultPosition", el => el.style.transform);
    record("default position: translate(25px, 25px)", def === "translate(25px, 25px)", def);

    // 14. Programmatic position through microflow buttons.
    await page.click(".mx-name-adjustXButton");
    await sleep(1200);
    const p1 = await page.$eval(".mx-name-boxProgrammatic", el => el.style.transform);
    await page.click(".mx-name-adjustYButton");
    await sleep(1200);
    const p2 = await page.$eval(".mx-name-boxProgrammatic", el => el.style.transform);
    const pText = await page.$eval(".mx-name-boxProgrammaticValues", el => el.textContent.trim());
    record("programmatic: Adjust x moved the box by -10", p1 === "translate(-10px, 0px)", p1);
    record("programmatic: Adjust y moved the box by -10", p2 === "translate(-10px, -10px)", `${p2} / ${pText}`);
    const prog = await moved(page, "boxProgrammatic", 40, 20);
    await sleep(400);
    const pText2 = await page.$eval(".mx-name-boxProgrammaticValues", el => el.textContent.trim());
    record("programmatic: dragging writes back to the attributes", pText2 === "x: 30, y: 10", pText2);

    // 15. Absolute position via class on the widget.
    const absPos = await page.$eval(".mx-name-boxAbsolute", el => getComputedStyle(el).position);
    record("absolute: widget root is position absolute", absPos === "absolute", absPos);

    // 16 + 17. Parent bounds arena.
    const arena = await page.$(".mxt-drag-arena");
    const arenaRect = await rect(arena);
    const free = await moved(page, "draggableFree", 3000, 3000);
    record("parent bounds: clamped inside the arena", free.after.x + free.after.w <= arenaRect.x + arenaRect.w + 1 && free.after.y + free.after.h <= arenaRect.y + arenaRect.h + 1, `card br=(${(free.after.x + free.after.w).toFixed(0)}, ${(free.after.y + free.after.h).toFixed(0)}) arena br=(${(arenaRect.x + arenaRect.w).toFixed(0)}, ${(arenaRect.y + arenaRect.h).toFixed(0)})`);
    const snap = await moved(page, "draggableSnap", 120, 80);
    record("parent bounds + x axis + grid 50", near(snap.dx, 100) && near(snap.dy, 0), `d=(${snap.dx.toFixed(0)}, ${snap.dy.toFixed(0)})`);

    await page.screenshot({ path: path.join(here, "ex-02-after.png"), fullPage: true });
    record("no console errors on the page", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 600) || "none");
} finally {
    await browser.close();
}

const failed = results.filter(r => !r.pass);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  -- ${r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
