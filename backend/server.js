import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import cron from "node-cron";
import { Client } from "@line/bot-sdk";

// Get directory path for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ====== CORS ======
app.use(cors());
app.use(bodyParser.json());

// ใช้ environment variable สำหรับ Spreadsheet ID เท่านั้น
const SPREADSHEET_ID =
    process.env.SPREADSHEET_ID ||
    "12n9WzxXMZPF7a0Dpb2c10LprXNQqkqojKFQGhVN-QcU";
const RANGE = "Users!A:E";

let sheets;

try {
    let serviceAccount;
    try {
        serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(
                /\\n/g,
                "\n"
            );
        }
    } catch (e) {
        console.error(
            "Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:",
            e.message
        );
        process.exit(1);
    }

    const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
    console.log(
        "✅ PRIVATE KEY FIRST LINE:",
        serviceAccount.private_key.split("\n")[0]
    );
    console.log(
        "✅ PRIVATE KEY LAST LINE:",
        serviceAccount.private_key.split("\n").slice(-2)
    );
    const auth = new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: SCOPES,
    });

    const client = await auth.getClient();
    sheets = google.sheets({ version: "v4", auth: client }); // ✅ ไม่มี const
    console.log("✅ Google Sheets API connected successfully");
} catch (error) {
    console.error("Google Sheets initialization error:", error.message);
    process.exit(1);
}

// const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
// const auth = new google.auth.GoogleAuth({
//   credentials: serviceAccount,
//   scopes: SCOPES,
// });

// const client = await auth.getClient(); // <--- ต้อง await
// sheets = google.sheets({ version: "v4", auth: client });
// console.log("Google Sheets API initialized successfully");
// } catch (error) {
//     console.error("Google Sheets initialization error:", error.message);
//     process.exit(1);
// }

// ฟังก์ชันช่วยแปลงเวลาเป็นโซนไทย
function getThaiDateTime() {
    const now = new Date();

    // shift เวลา UTC +7
    const bangkokTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);

    const date = bangkokTime.toISOString().split("T")[0]; // YYYY-MM-DD
    const time = bangkokTime.toTimeString().split(" ")[0]; // HH:mm:ss

    return { date, time };
}

app.get("/", (req, res) => {
    res.json({
        message: "Sugar Track API is running!",
        spreadsheet: SPREADSHEET_ID,
    });
});

app.get("/check-user", async (req, res) => {
    const { userId } = req.query;

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Users!A:A", // คอลัมน์ userId
    });

    const rows = response.data.values || [];
    const exists = rows.some((r) => r[0] === userId);

    res.json({ registered: exists });
});

app.get("/user", async (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "userId is required",
            });
        }

        // อ่านข้อมูลจาก Google Sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "Users!A:F", // userId | firstName | lastName | gender | birthDay | age
        });

        const rows = response.data.values;

        if (!rows || rows.length <= 1) {
            return res.json({
                success: false,
                notRegistered: true,
                message: "ไม่พบข้อมูลผู้ใช้ในระบบ",
            });
        }

        // ค้นหาข้อมูลผู้ใช้ (ข้าม header row)
        const userRow = rows.slice(1).find((row) => row[0] === userId);

        if (!userRow) {
            return res.json({
                success: false,
                notRegistered: true,
                message: "ผู้ใช้ยังไม่ได้ลงทะเบียน",
            });
        }

        // สร้าง user object
        const user = {
            userId: userRow[0],
            firstName: userRow[1] || "",
            lastName: userRow[2] || "",
            gender: userRow[3] || "",
            birthDay: userRow[4] || "",
            age: userRow[5] || "",
        };

        return res.json({
            success: true,
            user: user,
        });
    } catch (error) {
        console.error("Error fetching user:", error);
        return res.status(500).json({
            success: false,
            message: "เกิดข้อผิดพลาดในการดึงข้อมูล",
        });
    }
});

app.post("/register", async (req, res) => {
    const { userId, firstName, lastName, gender, birthDay } = req.body;

    if (!userId || !firstName || !lastName || !gender || !birthDay) {
        return res.json({ success: false, message: "ข้อมูลไม่ครบ" });
    }

    try {
        // ดึงข้อมูลทั้งหมดจากชีทมาก่อน
        const existing = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
        });

        const rows = existing.data.values || [];
        const isDuplicate = rows.some((row) => row[0] === userId);

        if (isDuplicate) {
            return res.json({
                success: false,
                message: "คุณเคยลงทะเบียนแล้ว สามารถกรอกค่าน้ำตาลได้เลย",
            });
        }

        // คำนวณอายุจากวันเกิด
        const birthDate = new Date(birthDay);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }

        // เพิ่มข้อมูลใหม่ลงชีท
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
            valueInputOption: "RAW",
            requestBody: {
                values: [[userId, firstName, lastName, gender, birthDay, age]],
            },
        });

        res.json({ success: true });
    } catch (err) {
        console.error("Google Sheets Error:", err);
        res.json({ success: false, message: err.message });
    }
});

// แก้ไข endpoint /sugar (ไม่ต้องตรวจสอบ token เพราะไม่ได้ส่งมา)
app.post("/sugar", async (req, res) => {
    try {
        // รองรับหลายชื่อตัวแปรจาก client
        const userId = req.body.userId || req.body.user_id;
        const sugarRaw = req.body.sugar ?? req.body.value ?? req.body.glucose;
        const sugar =
            typeof sugarRaw === "number" ? sugarRaw : Number(sugarRaw);

        const typeRaw =
            req.body.type ?? req.body.mealTiming ?? req.body.meal_timing;
        const periodRaw =
            req.body.period ?? req.body.timeOfDay ?? req.body.time_of_day;

        // ตรวจสอบความสมบูรณ์และชนิดข้อมูล
        if (
            !userId ||
            !Number.isFinite(sugar) ||
            sugar < 0 ||
            !typeRaw ||
            !periodRaw
        ) {
            return res.status(400).json({
                success: false,
                message: "ข้อมูลไม่ครบหรือไม่ถูกต้อง",
            });
        }

        // แปลงค่าอังกฤษ -> ไทย
        const type =
            typeRaw === "before"
                ? "ก่อนอาหาร"
                : typeRaw === "after"
                ? "หลังอาหาร"
                : typeRaw;
        const period =
            periodRaw === "morning"
                ? "เช้า"
                : periodRaw === "evening"
                ? "เย็น"
                : periodRaw;

        // 1) เช็คว่า user ลงทะเบียนหรือยัง
        let existingUsers;
        try {
            existingUsers = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: "Users!A:E",
            });
        } catch (sheetsError) {
            console.error("Google Sheets Error:", sheetsError);
            return res.status(503).json({
                success: false,
                message:
                    "ไม่สามารถเชื่อมต่อกับระบบจัดเก็บข้อมูลได้ กรุณาลองใหม่อีกครั้ง",
            });
        }

        const users = existingUsers.data.values || [];
        const isRegistered = users.some(
            (row) => String(row[0]) === String(userId)
        );

        if (!isRegistered) {
            return res.status(404).json({
                success: false,
                message: "กรุณาลงทะเบียนก่อนที่เมนูลงทะเบียน",
                notRegistered: true,
            });
        }

        // // สร้าง dateStr
        // const now = new Date();
        // const dateStr = now.toLocaleDateString("en-GB", {
        //   timeZone: "Asia/Bangkok",
        //   day: "numeric",
        //   month: "numeric",
        //   year: "numeric",
        // });

        const { date, time } = getThaiDateTime();

        // 2) เช็คการกรอกข้อมูลซ้ำ
        const existingRecords = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "SugarRecords!A:E",
        });

        const records = existingRecords.data.values || [];
        const dataRows = records.slice(1);

        const isDuplicate = dataRows.some((row) => {
            const [recordUserId, , recordType, recordPeriod, recordDate] = row;
            return (
                String(recordUserId) === String(userId) &&
                String(recordType) === String(type) &&
                String(recordPeriod) === String(period) &&
                String(recordDate) === String(date)
            );
        });

        if (isDuplicate) {
            return res.status(409).json({
                success: false,
                message: `คุณได้บันทึกข้อมูลค่าน้ำตาล "${type} มื้อ${period}" ในวันที่ ${dateStr} ไปแล้ว กรุณาเลือกช่วงเวลาอื่น`,
                isDuplicate: true,
            });
        }

        // 3) บันทึกลง SugarRecords
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: "SugarRecords!A:E",
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [[userId, sugar, type, period, date]],
            },
        });

        return res.json({
            success: true,
            message: "บันทึกค่าน้ำตaลสำเร็จ",
        });
    } catch (err) {
        console.error("Sugar endpoint error:", err);
        return res.status(500).json({
            success: false,
            message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์",
        });
    }
});

app.get("/sugar/records", async (req, res) => {
    const { userId, page = 1, limit = 12 } = req.query;
    console.log(
        "Getting sugar data for user:",
        userId,
        "page:",
        page,
        "limit:",
        limit
    );

    if (!userId) {
        return res.json({
            success: false,
            message: "userId required",
            records: [],
            pagination: null,
        });
    }

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "SugarRecords!A:E",
        });

        const rows = response.data.values || [];
        console.log("All rows:", rows);

        // ✅ ข้าม header row และกรองข้อมูลของ user
        const userRecords = rows
            .slice(1) // ข้าม header row
            .filter((r) => r && r[0] === userId);

        console.log(`Total user records: ${userRecords.length}`);

        // ✅ แปลงเป็น format ที่ frontend ต้องการ
        const allRecords = userRecords.map((r) => ({
            userId: r[0],
            sugar: r[1],
            type: r[2],
            period: r[3],
            date: r[4],
        }));

        // ✅ เรียงลำดับจากใหม่ไปเก่า
        allRecords.sort((a, b) => {
            const dateA = new Date(a.date.split("/").reverse().join("-"));
            const dateB = new Date(b.date.split("/").reverse().join("-"));
            return dateB - dateA;
        });

        // ✅ คำนวณ pagination
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 12;
        const totalRecords = allRecords.length;
        const totalPages = Math.ceil(totalRecords / limitNum);
        const startIndex = (pageNum - 1) * limitNum;
        const endIndex = startIndex + limitNum;

        // ✅ ตัดข้อมูลตาม pagination
        const paginatedRecords = allRecords.slice(startIndex, endIndex);

        console.log(
            `Page ${pageNum}/${totalPages}, showing ${paginatedRecords.length} records`
        );

        // ✅ ส่งข้อมูลพร้อม pagination info
        return res.json({
            success: true,
            records: paginatedRecords,
            pagination: {
                currentPage: pageNum,
                totalPages,
                totalRecords,
                recordsPerPage: limitNum,
                hasNext: pageNum < totalPages,
                hasPrev: pageNum > 1,
                nextPage: pageNum < totalPages ? pageNum + 1 : null,
                prevPage: pageNum > 1 ? pageNum - 1 : null,
            },
        });
    } catch (err) {
        console.error("Error fetching records:", err);
        res.status(500).json({
            success: false,
            message: err.message,
            records: [],
            pagination: null,
        });
    }
});

app.get("/sugar/:range", async (req, res) => {
    const { userId } = req.query;
    const rangeType = req.params.range;

    console.log(`Getting sugar data for user: ${userId}, range: ${rangeType}`);

    if (!userId) {
        return res.json({
            success: false,
            message: "userId required",
            labels: [],
            beforeMeal: [],
            afterMeal: [],
        });
    }

    try {
        const records = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "SugarRecords!A:E",
        });

        const data = records.data.values || [];
        console.log(`Total records: ${data.length}`);

        const userRecords = data.filter(
            (row) => String(row[0]) === String(userId)
        );
        console.log(`User records: ${userRecords.length}`);

        let labels = [];
        let beforeMeal = [];
        let afterMeal = [];

        if (rangeType === "weekly") {
            // หาวันที่ที่มีข้อมูลทั้งหมด และเรียงตามวันที่
            const uniqueDates = [...new Set(userRecords.map((r) => r[4]))];
            console.log("Unique dates found:", uniqueDates);

            // เรียงวันที่จากเก่าไปใหม่
            const sortedDates = uniqueDates.sort((a, b) => {
                const [dayA, monthA, yearA] = a.split("/").map(Number);
                const [dayB, monthB, yearB] = b.split("/").map(Number);
                const dateA = new Date(yearA, monthA - 1, dayA);
                const dateB = new Date(yearB, monthB - 1, dayB);
                return dateA - dateB;
            });

            // เอา 7 วันล่าสุด (หรือน้อยกว่าถ้าข้อมูลมีไม่ถึง 7 วัน)
            const last7Dates = sortedDates.slice(-7);
            console.log("Last 7 dates:", last7Dates);

            // สร้างกราฟสำหรับแต่ละวันและแต่ละช่วงเวลา
            last7Dates.forEach((dateStr) => {
                const shortDate = dateStr.split("/").slice(0, 2).join("/"); // แปลง "5/9/2025" เป็น "5/9"

                ["เช้า", "เย็น"].forEach((period) => {
                    labels.push(`${shortDate}-${period}`);

                    // หาข้อมูลก่อนอาหาร
                    const beforeRecord = userRecords.find(
                        (r) =>
                            r[4] === dateStr &&
                            r[2] === "ก่อนอาหาร" &&
                            r[3] === period
                    );

                    // หาข้อมูลหลังอาหาร
                    const afterRecord = userRecords.find(
                        (r) =>
                            r[4] === dateStr &&
                            r[2] === "หลังอาหาร" &&
                            r[3] === period
                    );

                    beforeMeal.push(
                        beforeRecord ? parseInt(beforeRecord[1]) : null
                    );
                    afterMeal.push(
                        afterRecord ? parseInt(afterRecord[1]) : null
                    );

                    console.log(`${shortDate}-${period}:`, {
                        before: beforeRecord ? beforeRecord[1] : null,
                        after: afterRecord ? afterRecord[1] : null,
                    });
                });
            });
        }

        console.log(`Final Response:`, {
            labels: labels.length,
            beforeMeal: beforeMeal.length,
            afterMeal: afterMeal.length,
            totalRecords: userRecords.length,
        });

        res.json({
            success: true,
            labels,
            beforeMeal,
            afterMeal,
            totalRecords: userRecords.length,
        });
    } catch (err) {
        console.error("Error fetching sugar data:", err);
        res.json({
            success: false,
            message: err.message || "เกิดข้อผิดพลาดในการดึงข้อมูล",
            labels: [],
            beforeMeal: [],
            afterMeal: [],
        });
    }
});

app.post("/medication-log", async (req, res) => {
    const { userId, timeOfDay, mealRelation, status } = req.body;

    if (!userId || !timeOfDay || !mealRelation || !status) {
        return res.json({
            success: false,
            message: "ข้อมูลไม่ครบ กรุณากรอกข้อมูลให้ครบถ้วน",
        });
    }

    try {
        const { date, time } = getThaiDateTime();

        // เพิ่มข้อมูลเข้าไปที่ชีท MedicationLogs
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: "MedicationLogs!A:F", // userId, date, timeOfDay, mealRelation, status, logTime
            valueInputOption: "RAW",
            requestBody: {
                values: [[userId, date, timeOfDay, mealRelation, status, time]],
            },
        });

        res.json({ success: true });
    } catch (err) {
        console.error("Google Sheets Error:", err);
        res.json({
            success: false,
            message: "ไม่สามารถบันทึกข้อมูลได้: " + err.message,
        });
    }
});

app.get("/medication/records", async (req, res) => {
    const { userId, page = 1, limit = 12 } = req.query;

    if (!userId) {
        return res.json({
            success: false,
            message: "ต้องระบุ userId",
        });
    }

    try {
        // ดึงข้อมูลจาก MedicationLogs sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "MedicationLogs!A:F", // userId, date, timeOfDay, mealRelation, status, logTime
        });

        const rows = response.data.values || [];

        // กรองข้อมูลตาม userId และข้าม header row
        const userRecords = rows.slice(1).filter((row) => {
            return row[0] && row[0].toString() === userId.toString();
        });

        // เรียงลำดับตามวันที่และเวลาจากใหม่ไปเก่า
        const sortedRecords = userRecords.sort((a, b) => {
            const dateA = new Date(a[1] + " " + (a[5] || "00:00:00"));
            const dateB = new Date(b[1] + " " + (b[5] || "00:00:00"));
            return dateB - dateA;
        });

        // คำนวณ pagination
        const totalRecords = sortedRecords.length;
        const totalPages = Math.ceil(totalRecords / limit);
        const currentPage = Math.max(1, Math.min(page, totalPages));
        const startIndex = (currentPage - 1) * limit;
        const endIndex = startIndex + parseInt(limit);

        // ดึงข้อมูลตามหน้า
        const paginatedRecords = sortedRecords.slice(startIndex, endIndex);

        // แปลงข้อมูลให้อยู่ในรูปแบบที่ต้องการ
        const formattedRecords = paginatedRecords.map((row) => {
            const [userId, date, timeOfDay, mealRelation, status, logTime] =
                row;

            return {
                date: date || "",
                timeOfDay: timeOfDay || "",
                mealRelation: mealRelation || "",
                status: status || "",
                logTime: logTime || "",
            };
        });

        res.json({
            success: true,
            records: formattedRecords,
            pagination: {
                currentPage: currentPage,
                totalPages: totalPages,
                totalRecords: totalRecords,
                limit: parseInt(limit),
                hasPrev: currentPage > 1,
                hasNext: currentPage < totalPages,
            },
        });
    } catch (err) {
        console.error("Google Sheets Error:", err);
        res.json({
            success: false,
            message: "ไม่สามารถดึงข้อมูลได้: " + err.message,
        });
    }
});

app.post("/appointment", async (req, res) => {
    const { userId, date, time, note } = req.body;

    if (!userId || !date || !time) {
        return res.json({ success: false, message: "กรุณากรอกวันและเวลา" });
    }

    try {
        // ตรวจสอบข้อมูลเก่า (optional)
        const existing = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "DoctorAppointments!A:D",
        });

        const rows = existing.data.values || [];
        const isDuplicate = rows.some(
            (row) => row[0] === userId && row[1] === date && row[2] === time
        );

        if (isDuplicate) {
            return res.json({
                success: false,
                message: "คุณได้บันทึกนัดนี้แล้ว",
            });
        }

        // เพิ่มข้อมูลใหม่
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: "DoctorAppointments!A:D",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[userId, date, time, note || ""]] },
        });

        res.json({ success: true, message: "บันทึกการนัดหมายเรียบร้อย" });
    } catch (err) {
        console.error("Google Sheets Error:", err);
        res.json({ success: false, message: err.message });
    }
});

// GET /appointment/records - ดึงข้อมูลการนัดหมายแบบมี pagination
app.get("/appointment/records", async (req, res) => {
    const { userId, page = 1, limit = 12 } = req.query;

    console.log(
        `Getting appointment records for user: ${userId}, page: ${page}, limit: ${limit}`
    );

    if (!userId) {
        return res.status(400).json({
            success: false,
            message: "ต้องระบุ userId",
            appointments: [],
            pagination: null,
        });
    }

    try {
        // ดึงข้อมูลการนัดหมายทั้งหมดจาก DoctorAppointments sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "DoctorAppointments!A:D", // userId, date, time, note
        });

        const rows = response.data.values || [];
        console.log(`Total appointment rows: ${rows.length}`);

        // กรองข้อมูลเฉพาะของ user นี้ และข้าม header row
        const userAppointments = rows
            .slice(1) // ข้าม header row
            .filter((row) => row && row[0] === userId);

        console.log(`User appointment records: ${userAppointments.length}`);

        // แปลงเป็น format ที่ frontend ต้องการ
        const allAppointments = userAppointments.map((row) => ({
            date: row[1] || "",
            time: row[2] || "",
            note: row[3] || "",
        }));

        // เรียงลำดับตามวันที่และเวลา จากใหม่ไปเก่า
        allAppointments.sort((a, b) => {
            const dateA = new Date(a.date + " " + a.time);
            const dateB = new Date(b.date + " " + b.time);
            return dateB - dateA; // เรียงจากใหม่ไปเก่า
        });

        // คำนวณ pagination
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 12;
        const totalRecords = allAppointments.length;
        const totalPages = Math.ceil(totalRecords / limitNum);
        const startIndex = (pageNum - 1) * limitNum;
        const endIndex = startIndex + limitNum;

        // ตัดข้อมูลตาม pagination
        const paginatedAppointments = allAppointments.slice(
            startIndex,
            endIndex
        );

        console.log(
            `Page ${pageNum}/${totalPages}, showing ${paginatedAppointments.length} appointments`
        );

        // ส่งข้อมูลพร้อม pagination info
        return res.json({
            success: true,
            appointments: paginatedAppointments,
            pagination: {
                currentPage: pageNum,
                totalPages,
                totalRecords,
                recordsPerPage: limitNum,
                hasNext: pageNum < totalPages,
                hasPrev: pageNum > 1,
                nextPage: pageNum < totalPages ? pageNum + 1 : null,
                prevPage: pageNum > 1 ? pageNum - 1 : null,
            },
        });
    } catch (err) {
        console.error("Error fetching appointment records:", err);
        res.status(500).json({
            success: false,
            message: err.message || "เกิดข้อผิดพลาดในการดึงข้อมูลการนัดหมาย",
            appointments: [],
            pagination: null,
        });
    }
});

// อัปเดต GET /appointment endpoint เดิมให้รองรับ pagination ด้วย (optional)
app.get("/appointment", async (req, res) => {
    const { userId, page, limit } = req.query;

    if (!userId) {
        return res.status(400).json({
            success: false,
            message: "userId required",
        });
    }

    try {
        // ถ้ามี page parameter ให้ redirect ไป /appointment/records
        if (page) {
            return res.redirect(
                `/appointment/records?userId=${userId}&page=${page}&limit=${
                    limit || 12
                }`
            );
        }

        // รักษา backward compatibility - ส่งข้อมูลทั้งหมดแบบเดิม
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "DoctorAppointments!A:D",
        });

        const rows = result.data.values || [];
        const records = rows.slice(1).filter((row) => row[0] === userId);

        // เรียงลำดับตามวันที่และเวลา
        const sortedRecords = records.sort((a, b) => {
            const dateA = new Date(a[1] + " " + a[2]);
            const dateB = new Date(b[1] + " " + b[2]);
            return dateB - dateA;
        });

        res.json({
            success: true,
            totalRecords: sortedRecords.length,
            appointments: sortedRecords.map(([userId, date, time, note]) => ({
                date,
                time,
                note: note || "",
            })),
        });
    } catch (err) {
        console.error("Error fetching appointments:", err);
        res.status(500).json({
            success: false,
            message: "Failed to fetch appointments",
        });
    }
});

// ตั้งค่า LINE Bot
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new Client(lineConfig);

// ฟังก์ชันสำหรับส่งข้อความแจ้งเตือน
async function sendReminderMessage(userId, appointment) {
    try {
        const message = {
            type: "text",
            text:
                `🏥 แจ้งเตือนการนัดหมาย\n\n` +
                `📅 วันที่: ${appointment.date}\n` +
                `⏰ เวลา: ${appointment.time}\n` +
                `📝 หมายเหตุ: ${appointment.note || "ไม่มี"}\n\n` +
                `💡 กรุณาเตรียมตัวและมาตรงเวลานะครับ/ค่ะ`,
        };

        await lineClient.pushMessage(userId, message);
        console.log(`Reminder sent to user: ${userId}`);
        return true;
    } catch (error) {
        console.error(`Failed to send reminder to ${userId}:`, error);
        return false;
    }
}

// ฟังก์ชันดึงข้อมูลการนัดหมายที่ต้องแจ้งเตือน
async function getAppointmentsToRemind() {
    try {
        // คำนวณวันพรุ่งนี้ (วันที่ต้องแจ้งเตือน)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDateString = tomorrow.toISOString().split("T")[0]; // YYYY-MM-DD

        console.log(`Checking appointments for date: ${tomorrowDateString}`);

        // ดึงข้อมูลจาก Google Sheets
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "DoctorAppointments!A:D",
        });

        const rows = result.data.values || [];

        // กรองเฉพาะการนัดหมายที่ตรงกับวันพรุ่งนี้
        const appointmentsToRemind = rows
            .slice(1) // ข้าม header
            .filter((row) => row && row[1] === tomorrowDateString)
            .map((row) => ({
                userId: row[0],
                date: row[1],
                time: row[2],
                note: row[3] || "",
            }));

        console.log(
            `Found ${appointmentsToRemind.length} appointments to remind`
        );
        return appointmentsToRemind;
    } catch (error) {
        console.error("Error fetching appointments to remind:", error);
        return [];
    }
}

// ฟังก์ชันหลักสำหรับส่งการแจ้งเตือน
async function sendDailyReminders() {
    console.log("Starting daily reminder process...");

    try {
        const appointments = await getAppointmentsToRemind();

        if (appointments.length === 0) {
            console.log("No appointments to remind today");
            return;
        }

        // ส่งการแจ้งเตือนทีละคน
        for (const appointment of appointments) {
            await sendReminderMessage(appointment.userId, appointment);
            // หน่วงเวลาเล็กน้อยเพื่อไม่ให้ส่งพร้อมกันมากเกินไป
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        console.log(
            `Daily reminders completed: ${appointments.length} notifications sent`
        );
    } catch (error) {
        console.error("Error in daily reminder process:", error);
    }
}

// ตั้งค่า Cron Job ให้ทำงานทุกวันเวลา 09:00
cron.schedule(
    "0 6 * * *",
    () => {
        console.log("Running daily appointment reminder job...");
        sendDailyReminders();
    },
    {
        scheduled: true,
        timezone: "Asia/Bangkok",
    }
);

app.post("/webhook", (req, res) => {
    console.log("Received webhook from LINE:", req.body);

    // ส่ง response กลับให้ LINE ทันที
    res.status(200).send("OK");
});

// เพิ่ม endpoint สำหรับทดสอบการส่งการแจ้งเตือนด้วยตนเอง
app.post("/test-reminder", async (req, res) => {
    try {
        await sendDailyReminders();
        res.json({
            success: true,
            message: "Daily reminders sent successfully",
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// เพิ่ม endpoint สำหรับทดสอบส่งข้อความหาคนเดียว
app.post("/test-single-reminder", async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.json({ success: false, message: "userId is required" });
    }

    try {
        const testAppointment = {
            date: "2025-09-15",
            time: "14:30",
            note: "นัดทดสอบระบบ",
        };

        const result = await sendReminderMessage(userId, testAppointment);
        res.json({
            success: result,
            message: result ? "Test reminder sent" : "Failed to send reminder",
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// ====== Start server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
