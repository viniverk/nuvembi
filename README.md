# NuvemBI — MVP de BI na nuvem

SaaS de BI para pequenas e médias empresas: o cliente cria uma conta, importa planilhas Excel/CSV
(ou exportações do Protheus/SAP) e recebe um painel pronto, com filtros, KPIs, gráficos e exportação.

## O que já funciona
- Login e cadastro (Firebase Authentication — e-mail e senha)
- Importação de **.xlsx, .xls, .csv** com escolha de aba
- Detecção automática de tipos, pensada para dados brasileiros e Protheus:
  - números `1.234,56`, `R$ 10,00`, `(50,00)` negativo
  - datas `dd/mm/aaaa`, `aaaa-mm-dd` e `aaaammdd` (ex.: `D2_EMISSAO`)
  - códigos com zero à esquerda (`000123`) ficam como texto
  - espaços extras dos campos do Protheus são removidos
- Painel automático montado na importação (KPIs, barras, rosca, evolução mensal, tabela)
- **Editor de painel** (botão "Editar painel"):
  - adicionar gráficos: Indicador, Colunas, Barras, Linha, Área, Pizza, Rosca, Tabela resumo, Tabela de dados
  - renomear, trocar dimensão/medida/cálculo, Top N, ordenação, cor e rótulos de dados (valor, % ou ambos) de cada gráfico
  - **tela livre**: arrastar o gráfico pelo título para qualquer posição (inclusive espaços vazios) e puxar o canto ◢ para mudar largura e altura; se cair em cima de outro, o outro desce
  - escolher quais filtros aparecem (colunas de texto, Ano e Mês)
  - duplicar e excluir gráficos
- Clique numa barra, fatia ou linha da tabela resumo para filtrar o painel
- Salvar o layout do painel e exportar CSV filtrado
- Cada cliente só vê os próprios dados (regras do Firestore)
- **Modo demo**: sem configurar o Firebase, tudo roda no navegador

## Estrutura
```
index.html              página única
css/style.css           visual
js/firebase-config.js   <- cole aqui a configuração do Firebase
js/app.js               telas e navegação
js/parser.js            leitura de Excel/CSV e tipos
js/dashboard.js         painel, gráficos e filtros
js/store.js             gravação (Firebase ou modo demo)
firestore.rules         regras de segurança
amostras/vendas-exemplo.csv  planilha para testar
```

## 1. Testar no seu computador (modo demo)
Os arquivos usam módulos JavaScript, então **não abra o index.html com duplo clique**.
Use um servidor local:
- **VS Code**: instale a extensão *Live Server* → botão direito no `index.html` → *Open with Live Server*; ou
- **Terminal** na pasta do projeto: `python -m http.server 8000` e abra `http://localhost:8000`

Entre com qualquer e-mail e uma senha de 6+ caracteres, vá em **Importar dados** e use `amostras/vendas-exemplo.csv`.

## 2. Ligar a nuvem (Firebase)
1. Acesse https://console.firebase.google.com → **Adicionar projeto** (ex.: `nuvembi`).
2. **Authentication** → Começar → **E-mail/senha** → Ativar.
3. **Firestore Database** → Criar banco → modo produção → região `southamerica-east1` (São Paulo).
4. Firestore → aba **Regras** → cole o conteúdo de `firestore.rules` → Publicar.
5. **Configurações do projeto** (engrenagem) → *Seus apps* → ícone **Web `</>`** → registre o app
   e copie o objeto `firebaseConfig` para `js/firebase-config.js`.
6. Recarregue o site: a barra lateral passa a mostrar **"Nuvem ativa"**.

## 3. Publicar no GitHub Pages
1. Crie um repositório (ex.: `nuvembi`) e envie todos os arquivos.
2. Repositório → **Settings → Pages** → Source: *Deploy from a branch* → `main` / `root`.
3. O site fica em `https://SEU-USUARIO.github.io/nuvembi/`.
4. No Firebase → Authentication → **Configurações → Domínios autorizados** → adicione `SEU-USUARIO.github.io`.

> Alternativa: **Firebase Hosting** (`npm i -g firebase-tools`, `firebase init hosting`, `firebase deploy`).

## Limites do MVP
- Até 3 milhões de linhas por painel (ajuste `MAX_ROWS` em `firebase-config.js`), guardadas em formato colunar comprimido (como o QVD): 1,2 milhão de linhas ≈ 11 MB.
- Os cálculos rodam no navegador do cliente: ótimo até algumas centenas de milhares de linhas.
- Plano gratuito do Firestore: 1 GiB armazenado e 50 mil leituras/dia — suficiente para os primeiros clientes.

## Próximas fases (roadmap)
| Fase | Entrega |
|---|---|
| 2 | **Agente Protheus**: programa instalado no servidor do cliente que consulta o SQL Server (SD2, SF2, SB1, SB2…) e envia para a nuvem em horários agendados. Conector Google Planilhas. |
| 2 | **Empresas e usuários**: uma empresa com vários usuários e permissões (admin / leitura). |
| 3 | **Cobrança**: planos mensais (ex.: Mercado Pago assinaturas) e limite de linhas por plano. |
| 3 | **SAP** (OData / agente local), painéis com múltiplos gráficos personalizados, compartilhamento por link. |
| 4 | Migração do processamento pesado para um banco analítico (BigQuery, Supabase/Postgres ou DuckDB) quando os volumes crescerem. |

**Por que um agente local?** Protheus e SAP normalmente ficam no servidor da empresa, fechados para a
internet. Em vez de abrir o banco para fora (arriscado), um pequeno programa roda dentro da rede do cliente
e *envia* os dados para a nuvem — o mesmo modelo do Qlik Data Gateway e do Power BI Gateway.

## Atualizações e cache do navegador
Os arquivos são carregados com um número de versão (`?v=5` no `index.html` e nos `import` do `js/app.js`).
Ao publicar uma mudança, aumente esse número nos dois lugares para que todos recebam a versão nova na hora.
