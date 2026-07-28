# Quiz Hurtz — Design Spec

Plataforma de criação de quiz interativo para geração e segmentação de leads.

## Stack

- React + TypeScript + Vite
- Tailwind CSS
- React Router DOM
- Framer Motion
- Zustand (estado global + persist localStorage)
- @dnd-kit/core (drag-and-drop no builder)
- lucide-react (ícones)

## Arquitetura

### Navegação

- **Dashboard como hub central** (`/`) — lista de quizzes, hub principal
- **Builder** (`/builder/:id`) — layout 2 colunas: lista de blocos (40%) + preview ao vivo (60%)
- **Quiz público** (`/q/:slug`) — tudo que o lead vê, incluindo resultado

### Store Zustand (store/quizStore.ts)

Store único com middleware `persist` salvando em localStorage.

- `quizzes: Quiz[]` — todos os quizzes criados
- `leads: Lead[]` — leads capturados
- Ações: `createQuiz`, `updateQuiz`, `deleteQuiz`, `duplicateQuiz`, `publishQuiz`, `addLead`, `getQuizBySlug`, `getLeadsByQuiz`

## Modelos de Dados

```typescript
type BlockType = 'multiple-choice' | 'image-choice' | 'text-input' | 'email-capture' | 'phone-capture' | 'result'

interface Quiz {
  id: string
  title: string
  slug: string
  status: 'draft' | 'published'
  primaryColor: string
  logoUrl: string
  backgroundUrl: string
  blocks: Block[]
  results: ResultProfile[]
  webhookUrl: string
  createdAt: string
  updatedAt: string
}

interface Block {
  id: string
  type: BlockType
  title: string
  options?: Option[]
  required: boolean
}

interface Option {
  id: string
  label: string
  imageUrl?: string
  score: number
  nextBlockId?: string        // undefined = ir para próximo bloco na ordem
}

interface ResultProfile {
  id: string
  minScore: number
  maxScore: number
  title: string
  description: string
  ctaText: string
  ctaUrl: string
}

interface Lead {
  id: string
  quizId: string
  name: string
  email: string
  phone: string
  score: number
  profileId: string
  answers: { blockId: string; optionId?: string; textValue?: string }[]
  createdAt: string
}
```

## Componentes

```
components/
├── ui/
│   ├── Button.tsx
│   ├── Input.tsx
│   ├── Modal.tsx
│   └── ProgressBar.tsx
├── Builder/
│   ├── BlockList.tsx       — lista de blocos com drag-and-drop
│   ├── BlockEditor.tsx     — edição inline do bloco selecionado
│   ├── BlockCard.tsx       — card individual na lista
│   ├── AddBlockMenu.tsx    — menu para adicionar bloco (escolhe tipo)
│   ├── QuizPreview.tsx     — preview ao vivo do quiz
│   └── StylePanel.tsx      — cor primária, logo, background
├── Quiz/
│   ├── QuestionScreen.tsx  — renderiza pergunta atual
│   ├── CaptureScreen.tsx   — captura nome/email/telefone
│   └── ResultScreen.tsx    — resultado por perfil de score
└── Dashboard/
    ├── QuizCard.tsx        — card de cada quiz na lista
    ├── LeadsTable.tsx      — tabela de leads com export CSV
    └── StatsCard.tsx       — estatísticas (respostas, conversão)
```

## Fluxos

### Dashboard

- Cards com quizzes criados (status rascunho/publicado)
- Botão "Novo Quiz" cria rascunho e abre Builder
- Cada card: total respostas, taxa conclusão, botão copiar URL, botão ver leads

### Builder

- Layout 2 colunas: lista de blocos (40%) + preview ao vivo (60%)
- Header com título editável, botão Publicar/Rascunho, personalização visual
- Blocos arrastáveis (@dnd-kit), clicar para editar inline, adicionar/remover
- Preview atualiza em tempo real
- Botão "Publicar" gera slug único e marca status como published

### Quiz Público

- Uma pergunta por vez com animação Framer Motion (slide)
- Barra de progresso no topo (gradiente roxo→cyan)
- Fluxo condicional: cada resposta verifica nextBlockId
- Antes do resultado: tela de captura (nome, e-mail, telefone)
- Resultado: ResultProfile correspondente ao score acumulado
- Ao finalizar: POST webhook fire-and-forget + salva lead no store

## Lógica do Quiz (hook useQuizFlow)

- Estado: bloco atual, respostas dadas, score acumulado
- Ao responder: soma score, verifica nextBlockId para redirecionamento
- Blocos de captura (email/phone) são renderizados como telas intermediárias
- Bloco tipo result: calcula score total, encontra ResultProfile com minScore ≤ score ≤ maxScore
- Finalização: dispara webhook e salva lead

## Webhook

POST fire-and-forget para `webhookUrl`:

```json
{
  "quizId": "abc123",
  "quizTitle": "Quiz X",
  "lead": {
    "name": "João",
    "email": "joao@email.com",
    "phone": "11999999999"
  },
  "score": 15,
  "profile": "Perfil A",
  "answers": [
    { "question": "Pergunta 1", "answer": "Opção B", "score": 5 },
    { "question": "Pergunta 2", "answer": "Opção A", "score": 10 }
  ],
  "completedAt": "2026-04-22T12:00:00Z"
}
```

Não bloqueia a tela de resultado se o webhook falhar.

## Visual

- Dark mode padrão: fundo `#0f172a`, cards `#1e293b`, bordas `#334155`
- Identidade vermelho/cyan: primária `#dc2626`, accent `#06b6d4`
- Mobile first: Builder empilha verticalmente no mobile
- Tailwind para tudo, sem CSS custom
- Ícones: Lucide React
- Transições suaves: Framer Motion para trocar perguntas, modais, expandir blocos
- Botões: rounded-xl, hover com scale sutil
- Barra de progresso: gradiente roxo→cyan

## Armazenamento

- **localStorage** via Zustand persist — quiz configs, blocos, leads capturados
- **Sem banco de dados** — leads são enviados para CRM via webhook
- Dados do quiz (config, blocos, resultados) persistidos localmente para o criador
