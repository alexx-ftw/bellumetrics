export const commanders = [
  { id: "napoleon-bonaparte", name: "Napoleón Bonaparte", shortName: "Napoleón", nation: "Francia", years: "1769-1821", era: "Edad contemporánea", domain: "Terrestre", confidence: 94, sources: 18, ratings: { historical: 1942, adjusted: 1889, tactical: 1964, strategic: 1881 }, summary: "Comandante y gobernante francés cuya carrera conecta las guerras revolucionarias y napoleónicas." },
  { id: "arthur-wellesley", name: "Arthur Wellesley", shortName: "Wellington", nation: "Reino Unido", years: "1769-1852", era: "Edad contemporánea", domain: "Terrestre", confidence: 93, sources: 16, ratings: { historical: 1878, adjusted: 1852, tactical: 1839, strategic: 1887 }, summary: "Comandante británico activo en India, la península ibérica y Waterloo." },
  { id: "mikhail-kutuzov", name: "Mijaíl Kutúzov", shortName: "Kutúzov", nation: "Imperio ruso", years: "1745-1813", era: "Edad contemporánea", domain: "Terrestre", confidence: 89, sources: 13, ratings: { historical: 1798, adjusted: 1841, tactical: 1742, strategic: 1901 }, summary: "Mariscal ruso asociado con la campaña de 1812 y la conservación del ejército ruso." },
  { id: "gebhard-blucher", name: "Gebhard von Blücher", shortName: "Blücher", nation: "Prusia", years: "1742-1819", era: "Edad contemporánea", domain: "Terrestre", confidence: 88, sources: 12, ratings: { historical: 1774, adjusted: 1738, tactical: 1761, strategic: 1789 }, summary: "Mariscal prusiano decisivo en las campañas de 1813-1815." },
  { id: "jean-de-soult", name: "Jean-de-Dieu Soult", shortName: "Soult", nation: "Francia", years: "1769-1851", era: "Edad contemporánea", domain: "Terrestre", confidence: 85, sources: 9, ratings: { historical: 1698, adjusted: 1718, tactical: 1731, strategic: 1672 }, summary: "Mariscal francés con larga experiencia operacional durante las guerras napoleónicas." },
  { id: "tipu-sultan", name: "Tipu Sultán", shortName: "Tipu", nation: "Mysore", years: "1751-1799", era: "Edad moderna", domain: "Terrestre", confidence: 82, sources: 10, ratings: { historical: 1726, adjusted: 1804, tactical: 1762, strategic: 1749 }, summary: "Gobernante y comandante de Mysore enfrentado a la expansión británica en India." },
  { id: "alexander-the-great", name: "Alejandro Magno", shortName: "Alejandro", nation: "Macedonia", years: "356-323 a. C.", era: "Antigüedad", domain: "Terrestre", confidence: 78, sources: 14, ratings: { historical: 1928, adjusted: 1961, tactical: 1982, strategic: 1914 }, summary: "Rey macedonio que derrotó al Imperio aqueménida y extendió su campaña hasta India." },
  { id: "darius-iii", name: "Darío III", shortName: "Darío III", nation: "Imperio aqueménida", years: "c. 380-330 a. C.", era: "Antigüedad", domain: "Terrestre", confidence: 69, sources: 8, ratings: { historical: 1432, adjusted: 1518, tactical: 1411, strategic: 1495 }, summary: "Último rey aqueménida, adversario principal de Alejandro durante la conquista de Persia." },
  { id: "porus", name: "Poros", shortName: "Poros", nation: "Pauravas", years: "siglo IV a. C.", era: "Antigüedad", domain: "Terrestre", confidence: 61, sources: 5, ratings: { historical: 1588, adjusted: 1704, tactical: 1692, strategic: 1561 }, summary: "Rey del Punyab que se enfrentó a Alejandro en el Hidaspes." },
  { id: "memnon-rhodes", name: "Memnón de Rodas", shortName: "Memnón", nation: "Imperio aqueménida", years: "c. 380-333 a. C.", era: "Antigüedad", domain: "Conjunto", confidence: 65, sources: 6, ratings: { historical: 1642, adjusted: 1721, tactical: 1688, strategic: 1754 }, summary: "Mercenario griego al servicio persa que dirigió una estrategia terrestre y naval contra Macedonia." },
  { id: "hannibal-barca", name: "Aníbal Barca", shortName: "Aníbal", nation: "Cartago", years: "247-c. 183 a. C.", era: "Antigüedad", domain: "Terrestre", confidence: 82, sources: 13, ratings: { historical: 1871, adjusted: 1948, tactical: 1991, strategic: 1817 }, summary: "General cartaginés célebre por su campaña italiana durante la segunda guerra púnica." },
  { id: "scipio-africanus", name: "Escipión el Africano", shortName: "Escipión", nation: "República romana", years: "236-183 a. C.", era: "Antigüedad", domain: "Terrestre", confidence: 84, sources: 12, ratings: { historical: 1842, adjusted: 1876, tactical: 1889, strategic: 1851 }, summary: "General romano vencedor en Hispania y en Zama." },
  { id: "fabius-maximus", name: "Quinto Fabio Máximo", shortName: "Fabio Máximo", nation: "República romana", years: "c. 280-203 a. C.", era: "Antigüedad", domain: "Terrestre", confidence: 75, sources: 8, ratings: { historical: 1712, adjusted: 1789, tactical: 1621, strategic: 1864 }, summary: "Dictador romano asociado con una estrategia de desgaste frente a Aníbal." },
  { id: "julius-caesar", name: "Julio César", shortName: "César", nation: "República romana", years: "100-44 a. C.", era: "Antigüedad", domain: "Terrestre", confidence: 89, sources: 17, ratings: { historical: 1896, adjusted: 1884, tactical: 1908, strategic: 1879 }, summary: "General y dirigente romano de las guerras de las Galias y la guerra civil." },
  { id: "pompey-magnus", name: "Pompeyo Magno", shortName: "Pompeyo", nation: "República romana", years: "106-48 a. C.", era: "Antigüedad", domain: "Conjunto", confidence: 84, sources: 13, ratings: { historical: 1779, adjusted: 1741, tactical: 1712, strategic: 1816 }, summary: "General romano con campañas en el Mediterráneo oriental y adversario de César." },
  { id: "vercingetorix", name: "Vercingétorix", shortName: "Vercingétorix", nation: "Coalición gala", years: "c. 82-46 a. C.", era: "Antigüedad", domain: "Terrestre", confidence: 70, sources: 7, ratings: { historical: 1584, adjusted: 1742, tactical: 1651, strategic: 1687 }, summary: "Líder arverno que coordinó la gran rebelión gala contra César." },
  { id: "saladin", name: "Saladino", shortName: "Saladino", nation: "Sultanato ayubí", years: "1137-1193", era: "Edad Media", domain: "Terrestre", confidence: 82, sources: 12, ratings: { historical: 1837, adjusted: 1816, tactical: 1798, strategic: 1884 }, summary: "Sultán ayubí que reunificó fuerzas regionales y combatió a los Estados cruzados." },
  { id: "richard-lionheart", name: "Ricardo Corazón de León", shortName: "Ricardo I", nation: "Reino de Inglaterra", years: "1157-1199", era: "Edad Media", domain: "Terrestre", confidence: 79, sources: 10, ratings: { historical: 1754, adjusted: 1801, tactical: 1842, strategic: 1688 }, summary: "Rey y comandante cruzado enfrentado a Saladino durante la tercera cruzada." },
  { id: "guy-lusignan", name: "Guy de Lusignan", shortName: "Guy", nation: "Reino de Jerusalén", years: "c. 1150-1194", era: "Edad Media", domain: "Terrestre", confidence: 72, sources: 8, ratings: { historical: 1408, adjusted: 1429, tactical: 1378, strategic: 1452 }, summary: "Rey de Jerusalén derrotado y capturado tras la batalla de Hattin." },
  { id: "genghis-khan", name: "Gengis Kan", shortName: "Gengis Kan", nation: "Imperio mongol", years: "c. 1162-1227", era: "Edad Media", domain: "Terrestre", confidence: 76, sources: 11, ratings: { historical: 1907, adjusted: 1894, tactical: 1882, strategic: 1952 }, summary: "Fundador del Imperio mongol y director de campañas a escala continental." },
  { id: "jalal-din", name: "Jalal ad-Din Mingburnu", shortName: "Jalal ad-Din", nation: "Imperio jorezmita", years: "c. 1199-1231", era: "Edad Media", domain: "Terrestre", confidence: 66, sources: 7, ratings: { historical: 1639, adjusted: 1724, tactical: 1692, strategic: 1651 }, summary: "Último gran gobernante jorezmita y adversario resistente de los mongoles." },
  { id: "belisarius", name: "Belisario", shortName: "Belisario", nation: "Imperio romano de Oriente", years: "c. 500-565", era: "Antigüedad tardía", domain: "Terrestre", confidence: 80, sources: 10, ratings: { historical: 1859, adjusted: 1912, tactical: 1902, strategic: 1844 }, summary: "General de Justiniano activo en Persia, África e Italia." },
  { id: "gelimer", name: "Gelimer", shortName: "Gelimer", nation: "Reino vándalo", years: "siglo VI", era: "Antigüedad tardía", domain: "Terrestre", confidence: 63, sources: 5, ratings: { historical: 1488, adjusted: 1537, tactical: 1511, strategic: 1467 }, summary: "Último rey vándalo de África y adversario de Belisario." },
  { id: "witiges", name: "Vitiges", shortName: "Vitiges", nation: "Reino ostrogodo", years: "m. 542", era: "Antigüedad tardía", domain: "Terrestre", confidence: 61, sources: 5, ratings: { historical: 1516, adjusted: 1574, tactical: 1532, strategic: 1541 }, summary: "Rey ostrogodo durante la primera fase de la guerra gótica de Justiniano." },
  { id: "yi-sun-sin", name: "Yi Sun-sin", shortName: "Yi Sun-sin", nation: "Joseon", years: "1545-1598", era: "Edad moderna", domain: "Naval", confidence: 85, sources: 12, ratings: { historical: 1881, adjusted: 1934, tactical: 1951, strategic: 1842 }, summary: "Almirante coreano destacado en las invasiones japonesas de Corea." },
  { id: "wakisaka-yasuharu", name: "Wakisaka Yasuharu", shortName: "Wakisaka", nation: "Japón", years: "1554-1626", era: "Edad moderna", domain: "Naval", confidence: 67, sources: 6, ratings: { historical: 1538, adjusted: 1582, tactical: 1512, strategic: 1564 }, summary: "Daimio y comandante naval japonés enfrentado a Yi Sun-sin en Hansan-do." },
  { id: "frederick-the-great", name: "Federico II de Prusia", shortName: "Federico II", nation: "Prusia", years: "1712-1786", era: "Edad moderna", domain: "Terrestre", confidence: 90, sources: 15, ratings: { historical: 1864, adjusted: 1829, tactical: 1888, strategic: 1842 }, summary: "Rey y comandante prusiano en las guerras de Silesia y de los Siete Años." },
  { id: "leopold-daun", name: "Leopold von Daun", shortName: "Daun", nation: "Monarquía de los Habsburgo", years: "1705-1766", era: "Edad moderna", domain: "Terrestre", confidence: 82, sources: 10, ratings: { historical: 1748, adjusted: 1772, tactical: 1791, strategic: 1726 }, summary: "Mariscal austríaco y uno de los adversarios más eficaces de Federico II." },
];

export const battles = [
  { id: "waterloo", name: "Waterloo", year: 1815, a: "napoleon-bonaparte", b: "arthur-wellesley", outcome: "Victoria aliada", confidence: 97 },
  { id: "borodino", name: "Borodinó", year: 1812, a: "napoleon-bonaparte", b: "mikhail-kutuzov", outcome: "Resultado disputado", confidence: 91 },
  { id: "ligny", name: "Ligny", year: 1815, a: "napoleon-bonaparte", b: "gebhard-blucher", outcome: "Victoria francesa", confidence: 95 },
  { id: "peninsular-soult", name: "Campaña peninsular", year: 1812, a: "arthur-wellesley", b: "jean-de-soult", outcome: "Ventaja aliada", confidence: 88 },
  { id: "seringapatam", name: "Seringapatam", year: 1799, a: "arthur-wellesley", b: "tipu-sultan", outcome: "Victoria británica y aliada", confidence: 84 },
  { id: "issus", name: "Issos", year: -333, a: "alexander-the-great", b: "darius-iii", outcome: "Victoria macedonia", confidence: 86 },
  { id: "hydaspes", name: "Hidaspes", year: -326, a: "alexander-the-great", b: "porus", outcome: "Victoria macedonia", confidence: 78 },
  { id: "granicus-campaign", name: "Campaña del Gránico", year: -334, a: "alexander-the-great", b: "memnon-rhodes", outcome: "Victoria macedonia", confidence: 68 },
  { id: "zama", name: "Zama", year: -202, a: "hannibal-barca", b: "scipio-africanus", outcome: "Victoria romana", confidence: 88 },
  { id: "fabian-campaign", name: "Campaña fabiana", year: -217, a: "hannibal-barca", b: "fabius-maximus", outcome: "Desgaste estratégico", confidence: 74 },
  { id: "pharsalus", name: "Farsalia", year: -48, a: "julius-caesar", b: "pompey-magnus", outcome: "Victoria cesariana", confidence: 91 },
  { id: "alesia", name: "Alesia", year: -52, a: "julius-caesar", b: "vercingetorix", outcome: "Victoria romana", confidence: 87 },
  { id: "arsuf", name: "Arsuf", year: 1191, a: "saladin", b: "richard-lionheart", outcome: "Victoria cruzada", confidence: 82 },
  { id: "hattin", name: "Hattin", year: 1187, a: "saladin", b: "guy-lusignan", outcome: "Victoria ayubí", confidence: 90 },
  { id: "indus", name: "Río Indo", year: 1221, a: "genghis-khan", b: "jalal-din", outcome: "Victoria mongola", confidence: 72 },
  { id: "tricamarum", name: "Tricamarum", year: 533, a: "belisarius", b: "gelimer", outcome: "Victoria romana", confidence: 80 },
  { id: "siege-rome", name: "Asedio de Roma", year: 537, a: "belisarius", b: "witiges", outcome: "Victoria defensiva romana", confidence: 78 },
  { id: "hansan", name: "Hansan-do", year: 1592, a: "yi-sun-sin", b: "wakisaka-yasuharu", outcome: "Victoria de Joseon", confidence: 84 },
  { id: "hochkirch", name: "Hochkirch", year: 1758, a: "frederick-the-great", b: "leopold-daun", outcome: "Victoria austríaca", confidence: 91 },
];

const commanderById = new Map(commanders.map((commander) => [commander.id, commander]));

export function rankCommanders(mode = "historical") {
  const allowed = new Set(["historical", "adjusted", "tactical", "strategic"]);
  const rating = allowed.has(mode) ? mode : "historical";
  return commanders
    .map((commander) => ({ ...commander, score: commander.ratings[rating] }))
    .sort((left, right) => right.score - left.score);
}

export function shortestPath(startId, endId) {
  if (!commanderById.has(startId) || !commanderById.has(endId)) return null;
  if (startId === endId) return [commanderById.get(startId)];

  const adjacency = new Map(commanders.map((commander) => [commander.id, []]));
  for (const battle of battles) {
    adjacency.get(battle.a)?.push(battle.b);
    adjacency.get(battle.b)?.push(battle.a);
  }

  const queue = [startId];
  const parent = new Map([[startId, null]]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const neighbor of adjacency.get(current) ?? []) {
      if (parent.has(neighbor)) continue;
      parent.set(neighbor, current);
      if (neighbor === endId) {
        const path = [];
        let cursor = endId;
        while (cursor !== null) {
          path.push(commanderById.get(cursor));
          cursor = parent.get(cursor);
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }

  return null;
}

export function getCommander(id) {
  return commanderById.get(id) ?? null;
}

export function battlesForCommander(id) {
  return battles.filter((battle) => battle.a === id || battle.b === id);
}
