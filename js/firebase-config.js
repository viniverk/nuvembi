// =============================================================
//  CONFIGURAÇÃO DO FIREBASE
// -------------------------------------------------------------
//  Enquanto "apiKey" estiver vazio, o site roda em MODO DEMO:
//  os dados ficam só no seu navegador (IndexedDB) e qualquer
//  e-mail entra. Ótimo para testar.
//
//  Para ligar a nuvem de verdade, cole aqui o objeto que o
//  Firebase mostra em: Configurações do projeto > Seus apps > Web.
//  (Esses valores são públicos; quem protege os dados são as
//  regras do arquivo firestore.rules.)
// =============================================================
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// Nome do produto exibido no site (troque à vontade)
export const APP_NAME = "NuvemBI";

// Limite de linhas por importação no MVP
export const MAX_ROWS = 100000;
