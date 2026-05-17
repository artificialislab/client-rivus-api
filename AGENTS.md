# Regras Do Projeto Para Agentes

Antes de trabalhar neste repositorio, siga tambem as regras operacionais do repo `lab-ops`.

## Fluxo obrigatorio

```text
alterar local -> testar -> commit -> push GitHub -> deploy VPS
```

## Proibido

- Editar codigo diretamente na VPS.
- Ler ou imprimir `.env`.
- Commitar secrets.
- Fazer deploy sem o codigo estar no GitHub.

## Permitido

- Alterar codigo localmente.
- Criar testes.
- Atualizar `.env.example`.
- Atualizar documentacao.

## VPS

Acesso direto a VPS exige frase explicita:

```text
Autorizo acesso direto a VPS [alias] para [objetivo].
```
