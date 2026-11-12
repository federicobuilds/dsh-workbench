import { readFile, writeFile } from 'node:fs/promises'
const file = new URL('./native-chat/src/client/locale.ts', import.meta.url)
let text = await readFile(file, 'utf8')
if (!text.includes("'message.edit.model':")) {
  const labels = [
    ['重新生成模型', '当前对话模型', '筛选模型', '正在加载模型…', '部分模型无法加载。', '重试'],
    ['Regeneration model', 'Current chat model', 'Filter models', 'Loading models…', 'Some models could not be loaded.', 'Retry'],
    ['再生成モデル', '現在のモデル', 'モデルを絞り込む', 'モデルを読み込み中…', '一部のモデルを読み込めませんでした。', '再試行'],
    ['Modelo de regeneración', 'Modelo actual del chat', 'Filtrar modelos', 'Cargando modelos…', 'No se pudieron cargar algunos modelos.', 'Reintentar'],
    ['Modèle de régénération', 'Modèle actuel', 'Filtrer les modèles', 'Chargement des modèles…', 'Certains modèles n’ont pas pu être chargés.', 'Réessayer'],
    ['Modell für neue Antwort', 'Aktuelles Chat-Modell', 'Modelle filtern', 'Modelle werden geladen…', 'Einige Modelle konnten nicht geladen werden.', 'Erneut versuchen'],
    ['Модель для нового ответа', 'Текущая модель чата', 'Фильтр моделей', 'Загрузка моделей…', 'Некоторые модели не удалось загрузить.', 'Повторить'],
    ['Modelo de regeneração', 'Modelo atual do chat', 'Filtrar modelos', 'Carregando modelos…', 'Alguns modelos não puderam ser carregados.', 'Tentar novamente'],
  ]
  const keys = ['model', 'currentModel', 'filterModels', 'loadingModels', 'modelsFailed', 'retryModels']
  let i = 0
  text = text.replace(/  'message\.edit\.regenerate': [^\n]+\n/g, line => line
    + keys.map((key, index) => `  'message.edit.${key}': ${JSON.stringify(labels[i][index])},\n`).join('')
    + (i++, ''))
  if (i !== 8) throw new Error('Expected all eight dictionaries')
  await writeFile(file, text)
}
