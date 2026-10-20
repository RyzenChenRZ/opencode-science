# Static file-effect analysis for an R script.
#
# Runs inside the user's own Rscript, so it needs no packages: `parse` is base
# R and gives an exact reading of the call structure rather than a text match.
#
# Output is a single JSON object on stdout. Paths that depend on a computed
# value are reported under "unknown" rather than guessed, matching the Python
# analyzer and the upstream contract: an unresolvable argument is unknown, not
# absent.
#
# Adapted from the upstream notebook-analysis contracts (Apache-2.0).

# Path-taking calls, and the argument position of the path.
#
# The index is not constant across R's file APIs: `write.csv(df, "f.csv")` takes
# the subject first, while `ggsave("f.png")` takes the path first. Getting this
# wrong reports "hello" as the written file for `writeLines("hello", "f.txt")`.

# R indexes a call from 1 with the function name at [[1]], so the path sits one
# position later than the argument list a reader would count. `write.csv(df,
# "f.csv")` is [[1]] name, [[2]] df, [[3]] path.
.write_index <- c(
  "write.csv" = 3, "write.table" = 3, "writeLines" = 3, "write" = 3,
  "saveRDS" = 3, "save" = 2, "save.image" = 3,
  "ggsave" = 2, "pdf" = 2, "png" = 2, "jpeg" = 2, "svg" = 2, "tiff" = 2,
  "bmp" = 2, "write_dta" = 3, "write_parquet" = 3, "write_xlsx" = 3,
  "write_sav" = 3, "write_fwf" = 3, "fwrite" = 2, "st_write" = 2,
  "write_pptx" = 2, "write_docx" = 2
)

.read_index <- c(
  "read.csv" = 2, "read.table" = 2, "read.delim" = 2, "readLines" = 2,
  "scan" = 2, "readRDS" = 2, "read" = 2, "load" = 2, "read_fwf" = 2,
  "read.dcf" = 2, "fread" = 2, "read_parquet" = 2, "read_excel" = 2,
  "read_xlsx" = 2, "read_sav" = 2, "read_dta" = 2, "st_read" = 2,
  "read_pptx" = 2, "read_docx" = 2, "file.exists" = 2, "file.size" = 2
)

# Directories the script creates. The path is the second argument.
.dir_calls <- c("dir.create")

# Calls that make the script's behaviour unrecoverable from static reading.
.dynamic_calls <- c("eval", "parse", "do.call", "source", "assign", "install.packages")

# Calls that hand a string to the shell. Reported separately from the dynamic
# calls: spawning a process is a different kind of effect from hiding what the
# code does, and both are worth seeing.
.subprocess_calls <- c("system", "system2")

# Escapes a string for a JSON string literal. The backslash is replaced first,
# so the backslashes the later replacements introduce are not escaped twice.
escape_json <- function(x) {
  x <- as.character(x)
  x <- gsub("\\", "\\\\", x, fixed = TRUE)
  x <- gsub("\"", "\\\"", x, fixed = TRUE)
  x <- gsub("\n", "\\n", x, fixed = TRUE)
  x <- gsub("\r", "\\r", x, fixed = TRUE)
  x <- gsub("\t", "\\t", x, fixed = TRUE)
  paste0("\"", x, "\"")
}

# Appends one entry to an effect list.
#
# `entry` is a named list such as list(path = "f.csv", call = "to_csv"), and
# `c(items, list(entry))` keeps it as one intact element. Wrapping it a second
# time, `list(list(entry))`, adds a level: the element becomes a list whose
# single name is the empty string, and `item$path` then yields NULL. Every
# append goes through here so the two shapes cannot diverge again.
append_entry <- function(items, entry) {
  c(items, list(entry))
}

record <- function(out, target, fname, expr, idx) {
  if (length(expr) < idx) return(out)
  arg <- expr[[idx]]
  if (is.character(arg) && length(arg) == 1 && !is.na(arg)) {
    out[[target]] <- append_entry(out[[target]], list(path = as.character(arg), call = fname))
  } else {
    out$unknown <- append_entry(out$unknown, list(call = fname, reason = "path is computed at run time"))
  }
  out
}

collect <- function(expr, out) {
  if (!is.call(expr)) {
    return(out)
  }

  fname <- tryCatch(as.character(expr[[1]]), error = function(e) "")
  if (length(fname) != 1 || is.na(fname)) fname <- ""

  # Dispatch on this call's own name. A name in neither table records nothing
  # here; it does not stop the walk, because the interesting call is usually
  # nested inside it (`df <- read.csv(...)`).
  if (nzchar(fname)) {
    if (fname %in% names(.write_index)) {
      out <- record(out, "writes", fname, expr, .write_index[[fname]])
    } else if (fname %in% names(.read_index)) {
      out <- record(out, "reads", fname, expr, .read_index[[fname]])
    } else if (fname %in% .dir_calls) {
      out <- record(out, "writes", fname, expr, 2)
    } else if (fname %in% .subprocess_calls) {
      out$subprocesses <- append_entry(out$subprocesses, list(call = fname))
    } else if (fname %in% .dynamic_calls) {
      out$dynamic <- append_entry(out$dynamic, list(call = fname))
    }
  }

  # Recurse unconditionally. Doing this only for recognised names is what lost
  # every read nested inside an assignment.
  for (i in seq_along(expr)) {
    if (i == 1) next
    # The recursive result must be assigned back. Discarding it loses every
    # effect found below this call, which is why a read inside an assignment
    # never reached the caller.
    out <- collect(expr[[i]], out)
  }

  out
}

# file.path("a", "b") resolves when every part is a literal.
resolve_path_call <- function(expr) {
  if (!is.call(expr)) return(NULL)
  fname <- tryCatch(as.character(expr[[1]]), error = function(e) "")
  if (length(fname) != 1 || is.na(fname)) return(NULL)
  if (!(fname %in% c("file.path", "paste0", "paste"))) return(NULL)

  parts <- character(0)
  for (i in seq_along(expr)) {
    if (i == 1) next
    arg <- expr[[i]]
    if (is.character(arg) && length(arg) == 1 && !is.na(arg)) {
      parts <- c(parts, as.character(arg))
    } else {
      return(NULL)
    }
  }
  if (length(parts) == 0) return(NULL)
  paste(parts, collapse = "/")
}

to_json_array <- function(items, fields) {
  if (length(items) == 0) return("[]")
  # `fields` must be normalised to a vector. In R, `for (x in "call")` yields
  # the four characters, so each item would be indexed by "c", "a", "l", "l"
  # and every lookup would fail with "subscript out of bounds".
  fields <- c(fields)
  parts <- character(0)
  for (item in items) {
    pieces <- character(0)
    for (field in fields) {
      value <- item[[field]]
      if (is.null(value)) next
      pieces <- c(pieces, paste0("\"", field, "\": ", escape_json(value)))
    }
    parts <- c(parts, paste0("{", paste(pieces, collapse = ", "), "}"))
  }
  paste0("[", paste(parts, collapse = ", "), "]")
}

main <- function() {
  con <- file("stdin", "r")
  source_text <- paste0(readLines(con, warn = FALSE), collapse = "\n")
  close(con)

  exprs <- tryCatch(parse(text = source_text, keep.source = FALSE), error = function(e) NULL)
  if (is.null(exprs)) {
    cat("{\"ok\": false, \"error\": \"syntax error\"}")
    return(invisible(NULL))
  }

  out <- list(
    writes = list(), reads = list(), unknown = list(),
    subprocesses = list(), dynamic = list()
  )
  for (i in seq_along(exprs)) {
    out <- collect(exprs[[i]], out)
  }

  # Paths the script constructs but does not obviously pass to a file API.
  built <- character(0)
  find_built <- function(expr) {
    if (is.call(expr)) {
      resolved <- resolve_path_call(expr)
      if (!is.null(resolved)) built <<- c(built, resolved)
      for (i in seq_along(expr)) {
        if (i == 1) next
        find_built(expr[[i]])
      }
    }
  }
  for (i in seq_along(exprs)) find_built(exprs[[i]])

  out$writes <- out$writes[!duplicated(vapply(out$writes, function(x) x$path, character(1)))]
  out$reads <- out$reads[!duplicated(vapply(out$reads, function(x) x$path, character(1)))]
  built <- unique(built)

  dynamic_json <- to_json_array(out$dynamic, "call")
  subprocess_json <- to_json_array(out$subprocesses, "call")
  built_json <- if (length(built) == 0) "[]" else to_json_array(lapply(built, function(p) list(path = p)), "path")

  cat(
    "{\"ok\": true, \"language\": \"r\",",
    "\"writes\":", to_json_array(out$writes, c("path", "call")), ",",
    "\"reads\":", to_json_array(out$reads, c("path", "call")), ",",
    "\"unknown\":", to_json_array(out$unknown, c("call", "reason")), ",",
    "\"networks\": [], \"subprocesses\": ", subprocess_json, ",",
    "\"dynamicCalls\": ", dynamic_json, ",",
    "\"constructedPaths\": ", built_json,
    "}"
  )
}

main()