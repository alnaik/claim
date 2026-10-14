"""Figures an answer worked out: a figure in no file that one simple step makes from two figures
the answer also gives and the files hold (or that were themselves worked out this way).

The steps are the ones answers about documents take, each between the kinds of figure it makes
sense for: amounts are added, subtracted or averaged into an amount; a percent or a plain ratio
("2.7 times") is one amount divided by another, or the growth from one to the other. Percents are
never added or averaged: 7.9% + 15.1% making 23.0% is a coincidence, not a calculation.

A result counts when it rounds to the figure as the answer wrote it, to the last digit it shows
(23.0% is anything from 22.95% to 23.05%). A figure written so roughly that this leaves more than
2% either way (9%, 0.4) is not worked out at all: too many pairs would fit. When several steps fit,
the one whose two figures sit nearest each other and the result in the answer is shown (an answer
gives a step's inputs together, next to what it makes of them), and the line says how
many others fit too, since claim can't tell which one the answer meant.
"""

from decimal import Decimal, DivisionByZero, InvalidOperation

ROUGH = Decimal("0.02")  # the most a figure's rounding may leave either way, as a share of it

# (formula, step, the kind both figures must be, the kinds the result may be, whether order matters)
STEPS = [
    ("{a} + {b}", lambda a, b: a + b, "amount", {"amount"}, False),
    ("{a} − {b}", lambda a, b: a - b, "amount", {"amount"}, True),
    ("({a} + {b}) ÷ 2", lambda a, b: (a + b) / 2, "amount", {"amount"}, False),
    ("{a} ÷ {b}", lambda a, b: a / b, "amount", {"percent", "number"}, True),
    ("{a} ÷ {b} − 1", lambda a, b: a / b - 1, "amount", {"percent"}, True),  # growth from b to a
]


def worked_out(at, value, unit, kind, known):
    """How the figure at answer word `at`, worth `value`, shown to `unit` and of `kind` (amount,
    percent or number), comes from two `known` figures ({word index: (value, spelling, kind)}), as
    (formula, [index a, index b]); None if no step fits, or if the figure is too rough to tell."""
    if value == 0 or unit / 2 / abs(value) > ROUGH:
        return None
    fits = {}  # (step, values) -> (distance, [i, j], formula)
    for i, (a, a_spelled, a_kind) in known.items():
        for j, (b, b_spelled, b_kind) in known.items():
            if i == j or at in (i, j):
                continue
            for form, step, given, makes, ordered in STEPS:
                if a_kind != given or b_kind != given or kind not in makes or (not ordered and i > j):
                    continue  # a sum or an average is written once, its figures in the answer's order
                try:
                    if abs(step(a, b) - value) > unit / 2:
                        continue
                except (DivisionByZero, InvalidOperation, ZeroDivisionError):
                    continue
                # One step is one step wherever its figures are repeated: keyed by their values.
                same = (form, a, b) if ordered else (form, min(a, b), max(a, b))
                distance = abs(i - j) + min(abs(i - at), abs(j - at))
                if same not in fits or distance < fits[same][0]:
                    fits[same] = (distance, [i, j], form.format(a=a_spelled, b=b_spelled))
    if not fits:
        return None
    _, inputs, formula = min(fits.values(), key=lambda f: f[0])
    others = len(fits) - 1
    if others:
        formula += f" (or {others} other way{'s' if others > 1 else ''})"
    return formula, inputs


def unit(digits, size, percent):
    """The last digit a figure shows, as a value: 23.0% shows tenths of a percent (0.001),
    $284.7B shows hundreds of millions, 2,100 shows ones."""
    decimals = len(digits.split(".")[1]) if "." in digits else 0
    return Decimal(1).scaleb(size - decimals) / (100 if percent else 1)
