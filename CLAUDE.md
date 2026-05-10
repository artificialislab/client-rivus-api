# Regras Do Projeto Para Claude

Siga o mesmo fluxo operacional usado pelo Codex.

```text
alterar local -> testar -> commit -> push GitHub -> deploy VPS
```

Nao acessar VPS, editar producao, reiniciar servicos ou manipular credenciais sem autorizacao explicita do Andre para a tarefa atual.

Frase obrigatoria:

```text
Autorizo acesso direto a VPS [alias] para [objetivo].
```

Nunca ler, imprimir, copiar ou versionar secrets.
