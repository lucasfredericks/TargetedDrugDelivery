"""Puzzle JSON format helpers.

Puzzle files on disk store receptors and ligands as arrays of named entries
(e.g. ``{"color": "Red", "value": 0.8}``) for human readability.  The
simulation and display code consume them as 6-element arrays indexed by color
number, so ``normalize_puzzle`` converts the named form to the indexed form
in place at the JSON-loading boundary.
"""

import logging

from config import LIGAND_COLORS

logger = logging.getLogger(__name__)

_COLOR_INDEX = {name: i for i, name in enumerate(LIGAND_COLORS)}


def _receptors_from_named(named):
    out = [0.0] * 6
    if not isinstance(named, list):
        return out
    for entry in named:
        i = _COLOR_INDEX.get(entry.get("color"))
        if i is None:
            logger.warning("Unknown color in puzzle receptors: %r", entry.get("color"))
            continue
        out[i] = float(entry.get("value", 0) or 0)
    return out


def _ligand_counts_from_named(named):
    out = [0] * 6
    if not isinstance(named, list):
        return out
    for entry in named:
        i = _COLOR_INDEX.get(entry.get("color"))
        if i is None:
            logger.warning("Unknown color in puzzle ligands: %r", entry.get("color"))
            continue
        out[i] += max(0, int(entry.get("count", 0) or 0))
    return out


def normalize_puzzle(puzzle):
    """Convert a puzzle JSON's named receptors/ligands to indexed arrays in place."""
    if not puzzle:
        return puzzle
    for tissue in puzzle.get("tissues", []) or []:
        receptors = tissue.get("receptors")
        if (isinstance(receptors, list) and receptors
                and isinstance(receptors[0], dict)):
            tissue["receptors"] = _receptors_from_named(receptors)
    if "ligands" in puzzle:
        puzzle["ligandCounts"] = _ligand_counts_from_named(puzzle["ligands"])
        del puzzle["ligands"]
    return puzzle
