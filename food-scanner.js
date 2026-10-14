"use strict";

(function () {
  const MAX_INPUT_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 40000000;
  const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
  const MAX_DIMENSION = 1024;

  function scannerError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function readImage(file) {
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      throw scannerError("Elige un archivo de imagen válido.", "INVALID_IMAGE");
    }
    if (file.size <= 0 || file.size > MAX_INPUT_BYTES) {
      throw scannerError("La imagen no debe superar 12 MB. Elige una foto más pequeña.", "IMAGE_TOO_LARGE");
    }

    if (typeof createImageBitmap !== "function") return readImageElement(file);
    return createImageBitmap(file).then((bitmap) => ({
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close()
    })).catch(() => readImageElement(file));
  }

  function readImageElement(file) {
    const objectUrl = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(objectUrl)
      });
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(scannerError("No se pudo abrir esa imagen. Prueba con una foto JPEG, PNG o WebP.", "INVALID_IMAGE"));
      };
      image.src = objectUrl;
    });
  }

  async function prepareImage(file) {
    const decoded = await readImage(file);
    try {
      if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_IMAGE_PIXELS) {
        throw scannerError("La resolución de la imagen es demasiado alta. Elige otra foto.", "IMAGE_DIMENSIONS");
      }
      const scale = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw scannerError("Este navegador no permite preparar la foto para el análisis.", "IMAGE_PROCESSING_UNAVAILABLE");
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      const encoded = dataUrl.split(",", 2)[1] || "";
      const outputBytes = Math.floor(encoded.length * 3 / 4);
      if (outputBytes <= 0 || outputBytes > MAX_OUTPUT_BYTES) {
        throw scannerError("No se pudo reducir la imagen lo suficiente. Elige otra foto.", "IMAGE_TOO_LARGE");
      }
      return { dataUrl, width: canvas.width, height: canvas.height };
    } finally {
      decoded.close();
    }
  }

  function validNutrient(value) {
    return value === null || (Number.isFinite(value) && value >= 0 && value <= 100000);
  }

  function validateResult(result) {
    if (!result || typeof result !== "object"
      || typeof result.is_food !== "boolean"
      || !["alta", "media", "baja"].includes(result.confidence)
      || typeof result.message !== "string"
      || result.message.length > 300
      || !Array.isArray(result.foods)
      || result.foods.length > 12
      || !Array.isArray(result.ingredients)
      || result.ingredients.length > 30
      || !result.ingredients.every((ingredient) => typeof ingredient === "string" && ingredient.length <= 80)
      || typeof result.meal_type !== "string"
      || result.meal_type.length > 80
      || !result.totals || typeof result.totals !== "object"
      || !["calories", "protein_g", "carbs_g", "fat_g"].every((key) =>
        Number.isFinite(result.totals[key]) && result.totals[key] >= 0 && result.totals[key] <= 100000)
      || !validNutrient(result.totals.fiber_g)) {
      throw scannerError("El servicio devolvió datos incompletos o no válidos. Inténtalo otra vez.", "INVALID_RESPONSE");
    }

    const foods = result.foods.map((food) => {
      if (!food || typeof food.name !== "string" || !food.name.trim() || food.name.length > 80
        || !Number.isFinite(food.grams) || food.grams <= 0 || food.grams > 10000
        || !["calories", "protein_g", "carbs_g", "fat_g"].every((key) =>
          Number.isFinite(food[key]) && food[key] >= 0 && food[key] <= 100000)
        || !validNutrient(food.fiber_g)) {
        throw scannerError("El servicio devolvió datos nutricionales no válidos. Inténtalo otra vez.", "INVALID_RESPONSE");
      }
      return { ...food, name: food.name.trim() };
    });

    if (result.is_food && foods.length === 0) {
      throw scannerError("El servicio no pudo identificar alimentos. Prueba con una foto más clara del plato.", "NO_FOOD");
    }
    return { ...result, foods };
  }

  async function getStatus() {
    const response = await fetch("/api/scan-food/status", {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload.configured !== "boolean") {
      throw scannerError("No se pudo comprobar la conexión con el servicio de análisis.", "SERVICE_UNAVAILABLE");
    }
    return payload;
  }

  async function analyze(imageData) {
    const response = await fetch("/api/scan-food", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ image: imageData })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw scannerError(
        payload && typeof payload.message === "string"
          ? payload.message
          : "No se pudo conectar con el servicio de análisis. Comprueba tu conexión e inténtalo de nuevo.",
        payload && typeof payload.code === "string" ? payload.code : "SERVICE_UNAVAILABLE"
      );
    }
    return validateResult(payload);
  }

  window.FitAIFoodScanner = Object.freeze({ prepareImage, getStatus, analyze });
})();
