"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

function loadEnvironmentFile() {
  let contents;
  try {
    contents = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error(`No se pudo leer .env: ${error.message}`);
  }

  contents.split(/\r?\n/).forEach((line, index) => {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) return;
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`La línea ${index + 1} de .env debe tener el formato CLAVE=valor.`);
    const name = entry.slice(0, separator).trim();
    let value = entry.slice(separator + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`La clave de la línea ${index + 1} de .env no es válida.`);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  });
}

loadEnvironmentFile();

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 8;
const rateBuckets = new Map();
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["is_food", "message", "confidence", "meal_type", "ingredients", "foods", "totals"],
  properties: {
    is_food: { type: "boolean" },
    message: { type: "string" },
    confidence: { type: "string", enum: ["alta", "media", "baja"] },
    meal_type: { type: "string" },
    ingredients: { type: "array", items: { type: "string" } },
    foods: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "grams", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g"],
        properties: {
          name: { type: "string" },
          grams: { type: "number" },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: ["number", "null"] }
        }
      }
    },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["calories", "protein_g", "carbs_g", "fat_g", "fiber_g"],
      properties: {
        calories: { type: "number" },
        protein_g: { type: "number" },
        carbs_g: { type: "number" },
        fat_g: { type: "number" },
        fiber_g: { type: ["number", "null"] }
      }
    }
  }
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function sendMapConfig(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { message: "Método no permitido." });
    return;
  }
  sendJson(response, 200, {
    tileUrl: process.env.MAP_TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: process.env.MAP_TILE_ATTRIBUTION
      || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
}

function sendScanStatus(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { message: "Método no permitido." });
    return;
  }
  sendJson(response, 200, { configured: Boolean(process.env.OPENAI_API_KEY) });
}

function pruneRateBuckets(now) {
  for (const [address, bucket] of rateBuckets) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(address);
  }
  while (rateBuckets.size > 10000) {
    rateBuckets.delete(rateBuckets.keys().next().value);
  }
}

function allowScanRequest(request) {
  const now = Date.now();
  pruneRateBuckets(now);
  const address = request.socket.remoteAddress || "unknown";
  let bucket = rateBuckets.get(address);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(address, bucket);
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT;
}

function readJsonBody(request, response) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        sendJson(response, 413, { code: "IMAGE_TOO_LARGE", message: "La foto es demasiado grande. Elige otra imagen." });
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("El cuerpo de la solicitud no contiene JSON válido."));
      }
    });
    request.on("error", reject);
  });
}

function validateImageData(imageData) {
  if (typeof imageData !== "string") return null;
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageData);
  if (!match || match[1].length % 4 !== 0) return null;
  const image = Buffer.from(match[1], "base64");
  if (image.length < 4 || image.length > MAX_IMAGE_BYTES) return null;
  if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) return null;
  return image;
}

function validateModelResult(result) {
  if (!result || typeof result !== "object"
    || typeof result.is_food !== "boolean"
    || !["alta", "media", "baja"].includes(result.confidence)
    || typeof result.message !== "string"
    || typeof result.meal_type !== "string"
    || result.meal_type.length > 80
    || !Array.isArray(result.ingredients)
    || result.ingredients.length > 30
    || !result.ingredients.every((ingredient) => typeof ingredient === "string" && ingredient.trim().length > 0 && ingredient.length <= 80)
    || !Array.isArray(result.foods)
    || result.foods.length > 12
    || !result.totals || typeof result.totals !== "object"
    || !["calories", "protein_g", "carbs_g", "fat_g"].every((key) =>
      Number.isFinite(result.totals[key]) && result.totals[key] >= 0)
    || !(result.totals.fiber_g === null || (Number.isFinite(result.totals.fiber_g) && result.totals.fiber_g >= 0))) {
    throw new Error("El modelo devolvió una respuesta incompleta.");
  }

  if (!result.is_food || result.foods.length === 0) {
    return {
      is_food: false,
      message: result.message.trim().slice(0, 240) || "No pudimos reconocer comida en esta foto. Prueba con una imagen más clara del plato.",
      confidence: result.confidence,
      meal_type: result.meal_type.trim().slice(0, 80),
      ingredients: [],
      foods: [],
      totals: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: null }
    };
  }

  const foods = result.foods.map((food) => {
    const name = typeof food.name === "string" ? food.name.trim() : "";
    const values = [food.grams, food.calories, food.protein_g, food.carbs_g, food.fat_g];
    if (!name || name.length > 80
      || !values.every(Number.isFinite)
      || food.grams <= 0 || food.grams > 10000
      || values.slice(1).some((value) => value < 0 || value > 100000)
      || !(food.fiber_g === null || (Number.isFinite(food.fiber_g) && food.fiber_g >= 0 && food.fiber_g <= 100000))) {
      throw new Error("El modelo devolvió datos nutricionales fuera del rango permitido.");
    }
    return {
      name,
      grams: Math.round(food.grams * 10) / 10,
      calories: Math.round(food.calories * 10) / 10,
      protein_g: Math.round(food.protein_g * 10) / 10,
      carbs_g: Math.round(food.carbs_g * 10) / 10,
      fat_g: Math.round(food.fat_g * 10) / 10,
      fiber_g: food.fiber_g === null ? null : Math.round(food.fiber_g * 10) / 10
    };
  });

  const totals = foods.reduce((sum, food) => ({
    calories: sum.calories + food.calories,
    protein_g: sum.protein_g + food.protein_g,
    carbs_g: sum.carbs_g + food.carbs_g,
    fat_g: sum.fat_g + food.fat_g
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  totals.fiber_g = foods.every((food) => food.fiber_g !== null)
    ? foods.reduce((sum, food) => sum + food.fiber_g, 0)
    : null;
  totals.calories = Math.round(totals.calories);
  totals.protein_g = Math.round(totals.protein_g * 10) / 10;
  totals.carbs_g = Math.round(totals.carbs_g * 10) / 10;
  totals.fat_g = Math.round(totals.fat_g * 10) / 10;
  if (totals.fiber_g !== null) totals.fiber_g = Math.round(totals.fiber_g * 10) / 10;

  return {
    is_food: true,
    message: "",
    confidence: result.confidence,
    meal_type: result.meal_type.trim().slice(0, 80),
    ingredients: [...new Set(result.ingredients.map((ingredient) => ingredient.trim().slice(0, 80)))],
    foods,
    totals
  };
}

async function scanFood(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { message: "Método no permitido." });
    return;
  }

  const origin = request.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      sendJson(response, 403, { message: "Origen no permitido." });
      return;
    }
    if (originHost !== request.headers.host) {
      sendJson(response, 403, { message: "Origen no permitido." });
      return;
    }
  }

  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    sendJson(response, 415, { message: "La solicitud debe contener una imagen JPEG en formato JSON." });
    return;
  }
  if (!allowScanRequest(request)) {
    sendJson(response, 429, { code: "RATE_LIMITED", message: "Se hicieron varios escaneos seguidos. Espera un minuto e inténtalo de nuevo." });
    request.resume();
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    sendJson(response, 503, { code: "MODEL_NOT_CONFIGURED", message: "El análisis no está configurado todavía. Añade OPENAI_API_KEY al entorno del servidor y reinícialo." });
    request.resume();
    return;
  }

  let body;
  try {
    body = await readJsonBody(request, response);
  } catch {
    sendJson(response, 400, { message: "No se pudo leer la solicitud. Vuelve a elegir la foto e inténtalo de nuevo." });
    return;
  }
  if (body === null) return;
  const image = validateImageData(body.image);
  if (!image) {
    sendJson(response, 400, { code: "INVALID_IMAGE", message: "La imagen no es un JPEG válido o supera el tamaño permitido. Prueba con otra foto." });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const modelResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
        max_output_tokens: 1400,
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Analiza esta foto de comida. Si ves uno o varios alimentos comestibles con claridad razonable, identifica hasta 12 componentes del plato (no utensilios ni adornos), estima los gramos comestibles y la nutrición aproximada de cada porción completa: calorías kcal, proteína, carbohidratos, grasas y fibra en gramos. Devuelve los valores por alimento, no por 100 g. Si la fibra no se puede estimar razonablemente, usa null. Indica el tipo de comida en meal_type y los ingredientes que sean visibles en ingredients; nunca presentes ingredientes ocultos como hechos. Estima con prudencia el tamaño de las porciones visibles; una foto no permite conocer su peso exacto ni las calorías precisas. Asigna confianza alta, media o baja según la visibilidad de alimentos y porciones. Si no hay comida, la foto no es un plato o no puedes entenderla, devuelve is_food false, foods vacío, ingredients vacío y un mensaje breve, amable y en español que sugiera tomar otra foto. Todos los campos deben estar presentes."
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${image.toString("base64")}`,
              detail: "high"
            }
          ]
        }],
        text: {
          format: {
            type: "json_schema",
            name: "food_nutrition_estimate",
            strict: true,
            schema: responseSchema
          }
        }
      })
    });

    if (modelResponse.status === 429) {
      sendJson(response, 429, { code: "MODEL_RATE_LIMITED", message: "El servicio de análisis está ocupado o alcanzó su límite temporal. Inténtalo de nuevo más tarde." });
      return;
    }
    if (modelResponse.status === 401 || modelResponse.status === 403) {
      sendJson(response, 503, { code: "MODEL_CONFIGURATION_ERROR", message: "El servidor no pudo autenticar el servicio de análisis. Revisa la configuración de la API key." });
      return;
    }
    if (!modelResponse.ok) {
      console.error(`OpenAI devolvió HTTP ${modelResponse.status} durante el análisis de comida.`);
      sendJson(response, 502, { code: "MODEL_REQUEST_FAILED", message: "No se pudo completar el análisis. Revisa tu conexión e inténtalo de nuevo." });
      return;
    }

    const modelResult = await modelResponse.json();
    const text = typeof modelResult.output_text === "string"
      ? modelResult.output_text
      : (modelResult.output || [])
        .flatMap((item) => item.content || [])
        .find((item) => item.type === "output_text")?.text;
    if (!text || modelResult.status === "incomplete") {
      sendJson(response, 502, { code: "MODEL_RESPONSE_INCOMPLETE", message: "No se pudo completar el análisis de la foto. Inténtalo de nuevo con una imagen más clara." });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(response, 502, { code: "MODEL_RESPONSE_INVALID", message: "El análisis no devolvió un resultado válido. Puedes intentar con otra foto." });
      return;
    }
    sendJson(response, 200, validateModelResult(parsed));
  } catch (error) {
    if (error.name === "AbortError") {
      sendJson(response, 504, { code: "MODEL_TIMEOUT", message: "El análisis tardó demasiado. Comprueba la conexión e inténtalo otra vez." });
      return;
    }
    console.error("Error al procesar el escaneo de comida:", error.message);
    sendJson(response, 502, { code: "MODEL_REQUEST_FAILED", message: "No se pudo completar el análisis de la imagen. Inténtalo de nuevo." });
  } finally {
    clearTimeout(timeout);
  }
}

function serveStatic(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { "Allow": "GET, HEAD" });
    response.end("Método no permitido.");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${HOST}:${PORT}`).pathname);
  } catch {
    response.writeHead(400);
    response.end("Solicitud no válida.");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(ROOT, `.${pathname}`);
  const relativePath = path.relative(ROOT, filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)
    || relativePath.toLowerCase() === "server.js"
    || !mimeTypes[extension]) {
    response.writeHead(404);
    response.end("No encontrado.");
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "No encontrado." : "No se pudo leer el archivo.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension],
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  });
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT debe ser un puerto válido entre 1 y 65535.");
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, `http://${HOST}:${PORT}`).pathname;
  if (pathname === "/api/map-config") {
    sendMapConfig(request, response);
    return;
  }
  if (pathname === "/api/scan-food/status") {
    sendScanStatus(request, response);
    return;
  }
  if (pathname === "/api/scan-food") {
    scanFood(request, response).catch((error) => {
      console.error("Error inesperado en /api/scan-food:", error.message);
      if (!response.headersSent) sendJson(response, 500, { message: "Ocurrió un error al procesar la solicitud. Vuelve a intentarlo." });
      else response.destroy();
    });
    return;
  }
  serveStatic(request, response);
});

server.requestTimeout = 60000;
server.headersTimeout = 65000;
server.listen(PORT, HOST, () => {
  console.log(`FitAI está disponible en http://${HOST}:${PORT}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("Falta OPENAI_API_KEY. El sitio funcionará, pero el escáner necesita configurar la clave en el entorno del servidor.");
  }
});
