"""Figures an answer worked out: a figure in no file that one simple step makes from two figures
the answer also gives and the files hold (or that were themselves worked out this way).

The steps are the ones answers about documents take: a sum, a difference, a product, a ratio,
the average of two, and growth from one to the other. A result counts when it rounds to the
figure as the answer wrote it, to the last digit it shows (23.0% is anything from 22.95% to
23.05%). Several steps can fit; the one whose two figures sit nearest the result in the answer
is kept, since an answer gives its inputs next to what it makes of them.
"""

from decimal import Decimal, DivisionByZero, InvalidOperation

STEPS = [
    ("{a} + {b}", lambda a, b: a + b),
    ("{a} − {b}", lambda a, b: a - b),
    ("{a} × {b}", lambda a, b: a * b),
    ("{a} ÷ {b}", lambda a, b: a / b),
    ("({a} + {b}) ÷ 2", lambda a, b: (a + b) / 2),
    ("{a} ÷ {b} − 1", lambda a, b: a / b - 1),  # growth from b to a
]


def worked_out(at, value, unit, known):
    """How the figure at answer word `at`, worth `value` and shown to `unit`, comes from two `known`
    figures ({word index: (value, spelling)}), as (formula, [index a, index b]); None if no step fits."""
    best = None
    for i, (a, a_spelled) in known.items():
        for j, (b, b_spelled) in known.items():
            if i == j or at in (i, j):
                continue
            for form, step in STEPS:
                try:
                    if abs(step(a, b) - value) > unit / 2:
                        continue
                except (DivisionByZero, InvalidOperation, ZeroDivisionError):
                    continue
                distance = abs(i - at) + abs(j - at)
                if best is None or distance < best[0]:
                    best = (distance, form.format(a=a_spelled, b=b_spelled), [i, j])
    return best and best[1:]


def unit(digits, size, percent):
    """The last digit a figure shows, as a value: 23.0% shows tenths of a percent (0.001),
    $284.7B shows hundreds of millions, 2,100 shows ones."""
    decimals = len(digits.split(".")[1]) if "." in digits else 0
    return Decimal(1).scaleb(size - decimals) / (100 if percent else 1)
