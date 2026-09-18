# infra fixture

Профиль `infra`: канон синхронизирует сюда только файлы без группы (verbatim-конфиги
линтеров/форматеров, create-if-absent сиды, `.prototools`) — здесь нет `package.json` и
`pnpm-workspace.yaml`, поэтому `stack sync` не создаёт и не трогает каталоги пакетов.
