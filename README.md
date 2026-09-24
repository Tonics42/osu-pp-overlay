# osu! PP Overlay

PP-калькулятор **прямо внутри osu!lazer**. В меню выбора карты появляется плашка с PP. Наведи на неё курсор, и откроется панель, где можно выбрать моды, точность, макс. комбо и количество миссов. PP пересчитываются сразу.

*In-game PP calculator overlay for osu!lazer: pick mods, accuracy, max combo and misses right in song select. [English below](#english).*

---

## Возможности
- Окно внутри игры (не отдельное окно Windows). Работает в полноэкранном режиме и в окне.
- Официальный калькулятор osu!lazer: текущая формула PP, все 4 режима, конверты.
- Моды lazer, включая настраиваемую скорость DT/NC/HT/DC (0.5x–2.0x). По умолчанию моды берутся из игры.
- Точность, макс. комбо и миссы. Внизу показаны PP при FC, разбивка aim/speed/acc/reading и таблица PP для 95–100%.
- Звёзды и AR/CS/OD/HP/BPM пересчитываются с учётом модов.
- Плашка почти ничего не закрывает и разворачивается при наведении курсора. Во время игры окно скрыто и ничего не рисует.

## Установка
1. Скачай `osu-pp-overlay-setup-*.exe` со страницы [Releases](../../releases/latest) и запусти его.
   Можно взять и портативную версию: `*-win-x64.zip`, распаковать и запустить `osu! PP Overlay.exe`.
2. При первом запуске программа сама скачает [tosu](https://github.com/tosuapp/tosu) (~45 МБ) с официального GitHub. По нему она узнаёт, какая карта выбрана в игре.
3. Запусти osu!lazer и зайди в выбор карты.

> Windows может показать предупреждение SmartScreen, потому что у программы нет цифровой подписи. Нажми «Подробнее» → «Выполнить в любом случае».

## Управление
| Действие | Как |
|---|---|
| Развернуть | Задержи курсор на плашке (~0,2 с) |
| Свернуть | Уведи курсор: игра сразу снова получает клики, окно сворачивается через полсекунды |
| Держать развёрнутым | Булавка в заголовке |
| Режим настройки без мыши | `Ctrl+Shift+P` (выход: `Esc`) |
| Скрыть / показать | `Ctrl+Shift+O` |
| Переместить | Перетащи за заголовок развёрнутого окна |

Меню в трее (иконка «pp»): перезагрузка оверлея, окно предпросмотра без игры, настройки, папка с логом, выход.

## Точность расчёта
Расчёт проверен на 512 реальных рекордах: я сравнил PP с сервера osu! с тем, что выдаёт окно при тех же модах, точности, комбо и миссах.

| Режим | Медиана расхождения |
|---|---|
| osu! (рекорды lazer), taiko, catch | 0,00–0,04% |
| mania | ~1,5%: по одной точности нельзя понять соотношение PERFECT/GREAT, поэтому раскладка моделируется по реальному разбросу попаданий |

## Настройки
Файл `%APPDATA%\osu! PP Overlay\config.json`, его можно открыть из меню в трее. Там горячие клавиши, размер (`panel.scale`), экраны, на которых показывается окно (`showStates`), и кликабельность при наведении (`hoverInteract`). После правки выбери в трее «Перезагрузить оверлей».

## Безопасность и риски
- Программа работает **только с osu!lazer**. В osu!stable, где есть античит, она не внедряется.
- Окно встраивается в игру через [asdf-overlay](https://github.com/storycraft/asdf-overlay): это та же библиотека, которую использует внутриигровой оверлей tosu. Случаев банов за это я не знаю, но гарантировать ничего не могу. Используй на свой риск.
- Встроенный оверлей tosu (`ENABLE_INGAME_OVERLAY`) не включай: два оверлея в одной игре будут мешать друг другу.

## Если что-то не работает
- Лог `overlay.log` лежит в `%APPDATA%\osu! PP Overlay`.
- Если после обновления lazer пропали данные о карте, значит нужна новая версия tosu. Он обновляется сам.
- Если окно не разворачивается наведением (например, включён «High precision mouse»), используй `Ctrl+Shift+P`.
- Без интернета при первом запуске положи `tosu.exe` в `%APPDATA%\osu! PP Overlay\tosu\`.

## Сборка из исходников
```bash
npm install
npm start          # запуск
npm run preview    # окно предпросмотра без игры
npm run dist       # установщик и zip в папке dist/
```

## Благодарности
- [tosu](https://github.com/tosuapp/tosu) читает из памяти игры, какая карта выбрана (LGPL-3.0)
- [tosuapp/lazer-calculator](https://github.com/tosuapp/lazer-calculator): официальные калькуляторы osu!lazer, собранные в нативный модуль (LGPL-3.0)
- [asdf-overlay](https://github.com/storycraft/asdf-overlay) встраивает окно в игру (MIT / Apache-2.0)
- [ppy/osu](https://github.com/ppy/osu): формулы сложности и PP

---

## English
**osu! PP Overlay** shows a small PP pill inside osu!lazer's song select. Hover it to open a panel where you can choose mods (including custom DT/NC/HT/DC speed), accuracy, max combo and misses. PP is recalculated instantly with the official osu!lazer difficulty and performance calculators.

- **Install:** download `osu-pp-overlay-setup-*.exe` from [Releases](../../releases/latest). On first launch the app downloads [tosu](https://github.com/tosuapp/tosu), which it uses to read the selected beatmap.
- **Controls:** rest the cursor on the pill to expand the panel; move the cursor away to collapse it. The pin button keeps the panel open. `Ctrl+Shift+P` enters settings mode without the mouse, `Ctrl+Shift+O` hides or shows the panel.
- **Accuracy:** checked against 512 real scores from the osu! servers. osu!, taiko and catch match with a median error of 0.00–0.04%; mania is within about 1.5%.
- **lazer only:** the app never attaches to osu!stable, which has an anti-cheat. It injects its window through asdf-overlay, the same library tosu uses for its in-game overlay. Use at your own risk.

License: MIT (see [LICENSE](LICENSE)). Third-party components keep their own licenses.
