const express = require("express");
const axios = require("axios");
const pointInPolygon = require("point-in-polygon");

const app = express();
const port = process.env.PORT || 3000;

// Configuração base do Axios para a API GLOBE
const GLOBE_BASE_URL = "https://api.globe.gov/";

/** ----------------------------
 * Função: Calcula pontuação da abelha
 * ---------------------------- */
function calcularPontuacaoAbelha(temperature, hasVegetation, latitude) {
  if (temperature == null) return 0;

  const vegetationScore = hasVegetation ? 1.0 : 0.05;

  let tempScore = 0;
  if (temperature >= 20 && temperature <= 32) tempScore = 1.0;
  else if (temperature > 15 && temperature < 38) tempScore = 0.5;

  const currentMonth = new Date().getMonth();
  const isNorthernHemisphere = latitude > 0;
  let seasonalityScore = 0;

  // Hemisfério Norte (Pico na Primavera/Verão: Março a Agosto - 2 a 7)
  if (isNorthernHemisphere) {
    if (currentMonth >= 2 && currentMonth <= 7)
      seasonalityScore = 1.0; // Março a Agosto
    else if (currentMonth === 8 || currentMonth === 9)
      seasonalityScore = 0.5; // Setembro, Outubro
    else seasonalityScore = 0.1; // Resto
    // Hemisfério Sul (Pico na Primavera/Verão: Setembro a Fevereiro - 8 a 1)
  } else {
    // Nota: currentMonth é 0 (Janeiro) a 11 (Dezembro).
    if (currentMonth >= 8 || currentMonth <= 1)
      seasonalityScore = 1.0; // Setembro a Fevereiro
    else if (currentMonth === 2 || currentMonth === 3)
      seasonalityScore = 0.5; // Março, Abril
    else seasonalityScore = 0.1; // Resto
  }

  return vegetationScore * tempScore * seasonalityScore;
}

/** ----------------------------
 * Função: Busca dados da Globe para uma bbox
 * ---------------------------- */
async function fetchGlobeData({ south, west, north, east }) {
  try {
    // URL corrigida
    const url = `${GLOBE_BASE_URL}search/v1/measurement/protocol/measureddate/country/?protocols=vegatation_covers&startdate=2023-05-05&enddate=2025-05-05&countrycode=USA&geojson=TRUE&sample=TRUE`;

    const response = await axios.get(url, { timeout: 20000 });
    const features = response.data.features || [];

    // Filtra apenas pontos dentro da bbox (Apenas pontos dentro da BBOX
    // são retornados, já que o endpoint por país retorna muitos dados)
    return features
      .map((f) => ({
        id: f.id,
        siteName: f.properties.siteName,
        countryName: f.properties.countryName,
        organizationName: f.properties.organizationName,
        elevation: f.properties.elevation,
        coordinates: f.geometry.coordinates,
      }))
      .filter(
        (f) =>
          f.coordinates[1] >= south &&
          f.coordinates[1] <= north &&
          f.coordinates[0] >= west &&
          f.coordinates[0] <= east
      );
  } catch (err) {
    console.warn("Falha ao buscar dados da Globe:", err.message);
    return [];
  }
}

/** ----------------------------
 * Rota principal /api/bee-map
 * ---------------------------- */
app.get("/api/bee-map", async (req, res) => {
  try {
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

    // 1. Busca Vegetação (OSM)
    const overpassQuery = `
      [out:json];
      (
        way["landuse"~"forest|meadow|orchard|farmland"](${south},${west},${north},${east});
        way["leisure"~"park|nature_reserve|garden"](${south},${west},${north},${east});
      );
      out geom;
    `;
    const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(
      overpassQuery
    )}`;
    const osmResponse = await axios.get(overpassUrl, { timeout: 25000 });
    const vegetationPolygons = osmResponse.data.elements.map((el) =>
      el.geometry.map((n) => [n.lon, n.lat])
    );

    // 2. Gera grade de pontos
    const gridSize = 15;
    const gridPoints = [];
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const pointLat = south + (i * (north - south)) / (gridSize - 1);
        const pointLon = west + (j * (east - west)) / (gridSize - 1);
        gridPoints.push({ lat: pointLat, lon: pointLon });
      }
    }

    // 3. Busca Temperaturas (Open-Meteo)
    const temperatures = [];
    // AUMENTADO O DELAY para 1500ms (1.5 segundos) para tentar evitar o erro 429
    const DELAY_MS = 1500;

    for (const point of gridPoints) {
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${point.lat.toFixed(
        4
      )}&longitude=${point.lon.toFixed(
        4
      )}&current=temperature_2m&temperature_unit=celsius`;

      try {
        const response = await axios.get(weatherUrl, { timeout: 15000 });
        temperatures.push(response.data.current.temperature_2m);
      } catch (err) {
        console.warn(
          `Erro (API 429?) ao buscar temperatura para (${point.lat.toFixed(
            2
          )}, ${point.lon.toFixed(2)}): ${err.message}`
        );
        temperatures.push(25); // Fallback seguro
      }

      // PAUSA DE 1.5 SEGUNDOS
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    // 4. Busca Dados da Globe
    const globeData = await fetchGlobeData({ south, west, north, east });

    // 5. Monta Heatmap + Dados Globe
    const result = gridPoints
      .map((point, index) => {
        // Pula pontos que não estão em vegetação (para performance)
        const hasVegetation = vegetationPolygons.some((polygon) =>
          pointInPolygon([point.lon, point.lat], polygon)
        );
        if (!hasVegetation) return null;

        const temperature = temperatures[index] || 25;
        const beeScore = calcularPontuacaoAbelha(temperature, true, point.lat);

        // Se a pontuação for muito baixa, ignora
        if (beeScore < 0.05) return null;

        // Verifica se há algum dado da Globe próximo
        const globePoint = globeData.find(
          (g) =>
            Math.abs(g.coordinates[1] - point.lat) < 0.001 &&
            Math.abs(g.coordinates[0] - point.lon) < 0.001
        );

        return {
          latitude: point.lat,
          longitude: point.lon,
          weight: parseFloat(beeScore.toFixed(3)), // Pontuação da abelha
          temperature: temperature,
          globe: globePoint || null,
        };
      })
      .filter(Boolean); // Remove os pontos nulos

    res.json(result);
  } catch (err) {
    console.error("Erro fatal na API:", err.message);
    res
      .status(500)
      .json({ error: "Erro ao processar solicitação: " + err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Backend rodando em http://localhost:${port}`);
});
