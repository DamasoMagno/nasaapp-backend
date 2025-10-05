const express = require("express");
const axios = require("axios");
const pointInPolygon = require("point-in-polygon");

const app = express();
const port = process.env.PORT || 3000;

// --- CORREÇÃO 1: A função agora recebe a latitude como parâmetro ---
function calcularPontuacaoAbelha(temperature, hasVegetation, latitude) {
  if (temperature === null || temperature === undefined) return 0;

  const vegetationScore = hasVegetation ? 1.0 : 0.05;

  let tempScore = 0;
  if (temperature >= 20 && temperature <= 32) tempScore = 1.0;
  else if (temperature > 15 && temperature < 38) tempScore = 0.5;

  const currentMonth = new Date().getMonth(); // 0 = Janeiro, 11 = Dezembro
  let seasonalityScore = 0;

  // A função agora usa o parâmetro 'latitude' em vez do 'req'
  const isNorthernHemisphere = latitude > 0;

  if (isNorthernHemisphere) {
    // Primavera/Verão no Hemisfério Norte
    if (currentMonth >= 2 && currentMonth <= 7)
      seasonalityScore = 1.0; // Mar-Ago
    else if (currentMonth === 8 || currentMonth === 9)
      seasonalityScore = 0.5; // Set-Out
    else seasonalityScore = 0.1;
  } else {
    // Primavera/Verão no Hemisfério Sul (Brasil)
    if (currentMonth >= 8 || currentMonth <= 1)
      seasonalityScore = 1.0; // Set-Fev
    else if (currentMonth === 2 || currentMonth === 3)
      seasonalityScore = 0.5; // Mar-Abr
    else seasonalityScore = 0.1;
  }

  return vegetationScore * tempScore * seasonalityScore;
}

app.get("/api/bee-map", async (req, res) => {
  try {
    console.log(
      "Recebida requisição para o mapa de abelhas (versão OpenStreetMap)..."
    );

    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).send({ error: "Latitude e longitude inválidas." });
    }

    const buffer = 0.5;
    const south = lat - buffer;
    const west = lon - buffer;
    const north = lat + buffer;
    const east = lon + buffer;
    const bbox = `${south},${west},${north},${east}`;

    console.log("Buscando polígonos de vegetação no OpenStreetMap...");
    const overpassQuery = `
            [out:json];
            (
              way["landuse"~"forest|meadow|orchard|farmland"](${bbox});
              way["leisure"~"park|nature_reserve|garden"](${bbox});
            );
            out geom;
        `;
    const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(
      overpassQuery
    )}`;

    const osmResponse = await axios.get(overpassUrl, { timeout: 25000 });

    const vegetationPolygons = osmResponse.data.elements.map((element) =>
      element.geometry.map((node) => [node.lon, node.lat])
    );
    console.log(
      `Encontrados ${vegetationPolygons.length} polígonos de vegetação.`
    );

    const gridSize = 15;
    const gridPoints = [];
    const lat_params = [];
    const lon_params = [];

    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const pointLat = south + (i * (north - south)) / (gridSize - 1);
        const pointLon = west + (j * (east - west)) / (gridSize - 1);
        gridPoints.push({ lat: pointLat, lon: pointLon });
        lat_params.push(pointLat.toFixed(2));
        lon_params.push(pointLon.toFixed(2));
      }
    }

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat_params.join(
      ","
    )}&longitude=${lon_params.join(",")}&current=temperature_2m`;

    console.log("Buscando dados de temperatura para a grade de pontos...");
    const weatherResponse = await axios.get(weatherUrl);

    const temperaturesData = Array.isArray(weatherResponse.data)
      ? weatherResponse.data
      : [weatherResponse.data];
    const temperatures = temperaturesData.map((d) => d.current.temperature_2m);

    console.log("Calculando pontuação final para cada ponto...");
    const heatmapData = gridPoints.map((point, index) => {
      const hasVegetation = vegetationPolygons.some((polygon) =>
        pointInPolygon([point.lon, point.lat], polygon)
      );
      const temperature = temperatures[index];

      // --- CORREÇÃO 2: Passando a latitude do ponto atual para a função ---
      const beeScore = calcularPontuacaoAbelha(
        temperature,
        hasVegetation,
        point.lat
      );

      return {
        latitude: point.lat,
        longitude: point.lon,
        weight: beeScore,
      };
    });

    console.log(`Enviando ${heatmapData.length} pontos de heatmap para o app.`);
    res.json(heatmapData);
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      console.error(
        "Erro no backend: A API do OpenStreetMap demorou demais (Timeout)."
      );
      res
        .status(504)
        .send({
          error:
            "O servidor de mapas (OpenStreetMap) está lento e não respondeu a tempo. Tente novamente.",
        });
    } else {
      console.error("Erro no backend:", error.message);
      res
        .status(500)
        .send({ error: "Ocorreu um erro ao processar a solicitação." });
    }
  }
});

app.listen(port, () => {
  console.log(
    `Backend (versão OpenStreetMap) rodando em http://localhost:${port}`
  );
});
