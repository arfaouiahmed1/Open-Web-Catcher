"""Embedded-page-stage models (plan task 14, batch W3).

Reserved canonical home for embedded-player models. Today the embedded-page
agent emits the shared extraction family defined in
``src.models.hosting`` (an ``ExtractionResult`` with
``page_type=PageType.EMBEDDED``), so this module defines no model yet; when
embedded-specific result models appear they belong here and must inherit
``src.models.common.PipelineModel`` (strict, ``extra="forbid"``).
"""
